/**
 * Control de flujo, espera exponencial y transporte HTTP.  →  pnpm test
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { endpointAeat } from '../config';
import { esperaReintentoSeg, POLITICA_REINTENTOS, proximoEnvio } from '../reintentos';
import { crearTransporteHttps, ErrorTransporte } from '../transporte';
import { SimuladorAeat } from './simulador-aeat';

describe('Espera exponencial entre reintentos', () => {
  const sinAzar = () => 0;

  it('duplica la espera con cada fallo y se detiene en una hora', () => {
    const esperas = Array.from({ length: 10 }, (_, i) => esperaReintentoSeg(i + 1, sinAzar));
    assert.deepEqual(esperas, [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600, 3600]);
  });

  it('NUNCA supera la hora: la Orden exige reintentar al menos una vez cada hora', () => {
    for (const fallos of [1, 5, 7, 8, 50, 1_000, 1e9]) {
      for (const azar of [0, 0.5, 0.999999, 1, 7, -3, Number.NaN]) {
        const espera = esperaReintentoSeg(fallos, () => azar);
        assert.ok(espera >= 1 && espera <= POLITICA_REINTENTOS.topeSeg, `fallos=${fallos} azar=${azar} → ${espera}`);
      }
    }
  });

  it('la dispersión solo acorta la espera, como mucho un 10 %', () => {
    assert.equal(esperaReintentoSeg(3, () => 0.5), 228); // 240 × (1 − 0,05)
    assert.equal(esperaReintentoSeg(3, () => 0.999999), 216);
    assert.equal(esperaReintentoSeg(0, sinAzar), 60, 'menos de un fallo se trata como uno');
  });

  it('próximo envío: tras una respuesta manda «t»; tras un fallo, lo más restrictivo', () => {
    const envio = new Date('2026-11-16T10:00:00Z');
    const mas = (seg: number) => new Date(envio.getTime() + seg * 1000);

    // La AEAT respondió con t = 60: el siguiente, un minuto después del envío.
    assert.deepEqual(proximoEnvio({ ahora: mas(2), ultimoEnvioEn: envio, tiempoEsperaSeg: 60, fallosConsecutivos: 0 }), mas(60));
    // Primer fallo detectado a los 30 s (timeout): ahora + 60 s.
    assert.deepEqual(proximoEnvio({ ahora: mas(30), ultimoEnvioEn: envio, tiempoEsperaSeg: 60, fallosConsecutivos: 1, aleatorio: sinAzar }), mas(90));
    // Si la AEAT había pedido esperar 10 minutos, un fallo no lo acorta.
    assert.deepEqual(proximoEnvio({ ahora: mas(1), ultimoEnvioEn: envio, tiempoEsperaSeg: 600, fallosConsecutivos: 1, aleatorio: sinAzar }), mas(600));
    // Séptimo fallo: una hora desde ahora.
    assert.deepEqual(proximoEnvio({ ahora: mas(5), ultimoEnvioEn: envio, tiempoEsperaSeg: 60, fallosConsecutivos: 7, aleatorio: sinAzar }), mas(3605));
  });
});

describe('Direcciones de los servicios de la AEAT', () => {
  it('son las del WSDL oficial, según entorno, tipo de certificado y servicio', () => {
    assert.equal(endpointAeat('produccion', 'certificado', 'VOLUNTARIA'), 'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    assert.equal(endpointAeat('produccion', 'sello', 'VOLUNTARIA'), 'https://www10.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    assert.equal(endpointAeat('pruebas', 'certificado', 'VOLUNTARIA'), 'https://prewww1.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP');
    assert.equal(endpointAeat('pruebas', 'sello', 'REQUERIMIENTO'), 'https://prewww10.aeat.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP');
    assert.equal(endpointAeat('produccion', 'certificado', 'REQUERIMIENTO'), 'https://www1.agenciatributaria.gob.es/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP');
  });
});

describe('Transporte HTTP', () => {
  let aeat: SimuladorAeat;
  const transporte = crearTransporteHttps(null);
  const xml = '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body/></soapenv:Envelope>';

  before(async () => {
    aeat = await SimuladorAeat.iniciar();
  });
  after(async () => {
    await aeat.cerrar();
  });

  const falla = async (promesa: Promise<unknown>) => {
    try {
      await promesa;
    } catch (error) {
      assert.ok(error instanceof ErrorTransporte, `se esperaba ErrorTransporte: ${error}`);
      return error;
    }
    assert.fail('se esperaba un fallo de transporte');
  };

  it('entrega el mensaje y devuelve código y cuerpo sin interpretarlos', async () => {
    aeat.encolar({ tipo: 'http', estado: 503 });
    const r = await transporte({ url: aeat.url('VerifactuSOAP'), xml, timeoutMs: 2_000 });
    assert.equal(r.estado, 503);
    assert.match(r.cuerpo, /Error 503/);
    assert.equal(aeat.peticiones.at(-1)!.xml, xml, 'el XML llega íntegro, en UTF-8');
  });

  it('sin conexión (puerto cerrado): el mensaje NO ha podido llegar', async () => {
    // Un puerto que estuvo abierto y ya no lo está: conexión rechazada al instante.
    const libre = await new Promise<number>((listo) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => listo(port));
      });
    });
    const error = await falla(transporte({ url: `http://127.0.0.1:${libre}/x`, xml, timeoutMs: 2_000 }));
    assert.equal(error.codigo, 'ECONNREFUSED');
    assert.equal(error.entregaIncierta, false);
  });

  it('timeout tras enviar: no se sabe si la AEAT lo procesó (entrega incierta)', async () => {
    aeat.encolar({ tipo: 'silencio' });
    const inicio = Date.now();
    const error = await falla(transporte({ url: aeat.url('VerifactuSOAP'), xml, timeoutMs: 250 }));
    assert.equal(error.codigo, 'TIMEOUT');
    assert.equal(error.entregaIncierta, true);
    assert.ok(Date.now() - inicio < 1_500, 'el timeout se respeta');
  });

  it('conexión cortada tras enviar: también es entrega incierta', async () => {
    aeat.encolar({ tipo: 'cortar' });
    const error = await falla(transporte({ url: aeat.url('VerifactuSOAP'), xml, timeoutMs: 2_000 }));
    assert.equal(error.entregaIncierta, true);
  });

  it('solo admite HTTP(S)', async () => {
    const error = await falla(transporte({ url: 'ftp://127.0.0.1/x', xml, timeoutMs: 500 }));
    assert.equal(error.codigo, 'URL_NO_VALIDA');
  });
});
