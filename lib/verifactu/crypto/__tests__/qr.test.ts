/** Tests unitarios del contenido del código QR.  →  pnpm test */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorDominio } from '../../errores';
import { contenidoQr, urlQr, type DatosQr } from '../qr';

const base: DatosQr = {
  nif: '89890001K',
  numSerieFactura: '12345678/G33',
  fechaExpedicion: '2024-01-01',
  importeTotal: '241.4',
  modo: 'VERIFACTU',
  entorno: 'produccion',
};

describe('URL del código QR', () => {
  it('VERI*FACTU en producción: servicio de cotejo y cuatro parámetros en orden', () => {
    assert.equal(
      urlQr(base),
      'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%2FG33&fecha=01-01-2024&importe=241.40'
    );
  });

  it('cambia de servicio según el modo y de servidor según el entorno', () => {
    const origenYRuta = (d: Partial<DatosQr>) => urlQr({ ...base, ...d }).split('?')[0];
    assert.equal(origenYRuta({ modo: 'NO_VERIFACTU' }), 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu');
    assert.equal(origenYRuta({ entorno: 'pruebas' }), 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR');
    assert.equal(origenYRuta({ entorno: 'pruebas', modo: 'NO_VERIFACTU' }), 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu');
  });

  it('codifica los caracteres especiales del número de factura y se puede volver a leer', () => {
    const numSerieFactura = 'F 26/001&x=1#ñ';
    const url = new URL(urlQr({ ...base, numSerieFactura }));
    assert.ok(url.search.includes('numserie=F%2026%2F001%26x%3D1%23%C3%B1'));
    // Lo que lee la AEAT al decodificar es exactamente lo que se registró.
    assert.equal(url.searchParams.get('numserie'), numSerieFactura);
    assert.deepEqual([...url.searchParams.keys()], ['nif', 'numserie', 'fecha', 'importe']);
  });

  it('usa el mismo formato de importe y de fecha que la huella', () => {
    const params = (d: Partial<DatosQr>) => new URL(urlQr({ ...base, ...d })).searchParams;
    assert.equal(params({ importeTotal: '121' }).get('importe'), '121.00');
    assert.equal(params({ importeTotal: 8.38 }).get('importe'), '8.38');
    assert.equal(params({ importeTotal: '-12.1' }).get('importe'), '-12.10');
    assert.equal(params({ fechaExpedicion: '2026-11-16' }).get('fecha'), '16-11-2026');
  });

  it('rechaza datos inválidos en lugar de generar un QR que no cotejaría', () => {
    assert.throws(() => urlQr({ ...base, nif: 'B1234' }), ErrorDominio);
    assert.throws(() => urlQr({ ...base, numSerieFactura: 'X'.repeat(61) }), ErrorDominio);
    assert.throws(() => urlQr({ ...base, importeTotal: '12.345' }), ErrorDominio);
    assert.throws(() => urlQr({ ...base, fechaExpedicion: '01-01-2024' }), ErrorDominio);
    assert.throws(() => urlQr({ ...base, entorno: 'otro' as never }), ErrorDominio);
  });
});

describe('Contenido estructurado del QR', () => {
  it('VERI*FACTU: URL, parámetros, condiciones de impresión y leyenda obligatoria', () => {
    assert.deepEqual(contenidoQr(base), {
      url: urlQr(base),
      parametros: { nif: '89890001K', numserie: '12345678/G33', fecha: '01-01-2024', importe: '241.40' },
      verificable: true,
      norma: 'ISO/IEC 18004',
      nivelCorreccion: 'M',
      tamanoMm: { minimo: 30, maximo: 40 },
      textoSuperior: 'QR tributario:',
      leyenda: { larga: 'Factura verificable en la sede electrónica de la AEAT', corta: 'VERI*FACTU' },
    });
  });

  it('NO VERI*FACTU: lleva QR pero no puede llevar la leyenda de factura verificable', () => {
    const qr = contenidoQr({ ...base, modo: 'NO_VERIFACTU' });
    assert.equal(qr.verificable, false);
    assert.equal(qr.leyenda, null);
    assert.ok(qr.url.includes('/ValidarQRNoVerifactu?'));
  });
});
