/**
 * Generador del XML de los registros de facturación.  →  pnpm test
 *
 * Lo esencial: lo que se genera CUMPLE el XSD oficial de la AEAT y reproduce,
 * carácter a carácter, los valores con los que se calculó la huella.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { XMLParser } from 'fast-xml-parser';
import { ErrorDominio } from '../../errores';
import { serializarRegistroAlta, serializarRegistroAnulacion } from '../registro-xml';
import { datosAlta, datosAnulacion, desglose, EMPRESA, factura, relacionada, SIF } from './datos-prueba';
import { erroresXsd, xsdDisponible } from './validar-xsd';

const leer = (xml: string) =>
  new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true }).parse(xml);
const omitir = xsdDisponible ? false : 'xmllint no está instalado: no se puede validar contra el XSD';

describe('RegistroAlta', () => {
  it('cumple el XSD oficial (factura completa con destinatario y operación exenta)', { skip: omitir }, () => {
    assert.equal(erroresXsd(serializarRegistroAlta(datosAlta()), 'SuministroInformacion.xsd'), null);
  });

  it('cumple el XSD en sus variantes: ticket primero de la cadena, rectificativa, IDOtro, recargo', { skip: omitir }, () => {
    const variantes = [
      // Ticket sin destinatario, primer registro de la cadena.
      datosAlta({
        factura: factura({ tipoFactura: 'F2', destinatarioNombre: null, destinatarioNif: null }),
        desglose: [desglose()],
        encadenamiento: { esPrimerRegistro: true, registroAnterior: null },
      }),
      // Rectificativa por sustitución de dos facturas, con fecha de operación.
      datosAlta({
        factura: factura({
          tipoFactura: 'R1', tipoRectificativa: 'S', baseRectificada: '100.00', cuotaRectificada: '21.00',
          fechaOperacion: '2026-10-31', importeTotal: '-12.10', cuotaTotal: '-2.10',
        }),
        relacionadas: [relacionada(), relacionada({ id: '55555555-5555-4555-8555-555555555556', referidaNumSerie: 'F26-000004' })],
      }),
      // Rectificativa por diferencias: sin «ImporteRectificacion».
      datosAlta({ factura: factura({ tipoFactura: 'R4', tipoRectificativa: 'I' }), relacionadas: [relacionada()] }),
      // Sustitución de simplificadas (F3).
      datosAlta({ factura: factura({ tipoFactura: 'F3' }), relacionadas: [relacionada({ relacion: 'SUSTITUIDA', referidaNumSerie: 'T26-000007' })] }),
      // Destinatario extranjero identificado con «IDOtro».
      datosAlta({
        factura: factura({ destinatarioNif: null, destinatarioIdOtroCodigoPais: 'FR', destinatarioIdOtroTipo: '02', destinatarioIdOtroNumero: 'FR12345678901' }),
      }),
      // Recargo de equivalencia, IGIC y operación no sujeta.
      datosAlta({
        desglose: [
          desglose({ tipoRecargoEquivalencia: '5.20', cuotaRecargoEquivalencia: '5.20' }),
          desglose({ id: '44444444-4444-4444-8444-444444444446', impuesto: '03', tipoImpositivo: '7.00', cuotaRepercutida: '7.00' }),
          desglose({ id: '44444444-4444-4444-8444-444444444447', calificacionOperacion: 'N1', tipoImpositivo: null, cuotaRepercutida: null }),
          desglose({ id: '44444444-4444-4444-8444-444444444448', impuesto: '02', tipoImpositivo: '4.00', cuotaRepercutida: '4.00' }),
        ],
      }),
      // Subsanación tras un rechazo previo.
      datosAlta({ esSubsanacion: true, rechazoPrevio: 'X' }),
    ];
    for (const [i, datos] of variantes.entries()) {
      assert.equal(erroresXsd(serializarRegistroAlta(datos), 'SuministroInformacion.xsd'), null, `variante ${i}`);
    }
  });

  it('escribe huella, fecha-hora e importes EXACTAMENTE como entraron en la huella', () => {
    const datos = datosAlta({ factura: factura({ cuotaTotal: '21.00', importeTotal: '171.00' }) });
    const { RegistroAlta: r } = leer(serializarRegistroAlta(datos));

    assert.equal(r.Huella, datos.huella);
    assert.equal(r.TipoHuella, '01');
    assert.equal(r.FechaHoraHusoGenRegistro, '2026-11-16T10:30:00+01:00');
    assert.equal(r.CuotaTotal, '21.00');
    assert.equal(r.ImporteTotal, '171.00');
    assert.deepEqual(r.IDFactura, { IDEmisorFactura: EMPRESA.nif, NumSerieFactura: 'F26-000012', FechaExpedicionFactura: '16-11-2026' });
    // Encadenamiento: identifica al registro anterior con SU huella.
    assert.equal(r.Encadenamiento.RegistroAnterior.Huella, 'A'.repeat(64));
    assert.equal(r.Encadenamiento.RegistroAnterior.FechaExpedicionFactura, '15-11-2026');
    // «RefExterna» lleva el identificador interno del registro.
    assert.equal(r.RefExterna, datos.registroId);
    assert.equal(r.IDVersion, '1.0');
  });

  it('describe el sistema informático tal como figura en la declaración responsable', () => {
    const { RegistroAlta: r } = leer(serializarRegistroAlta(datosAlta()));
    assert.deepEqual(r.SistemaInformatico, {
      NombreRazon: 'Productor de Pruebas, S.L.', NIF: 'B12345674',
      NombreSistemaInformatico: 'Verifactu SaaS', IdSistemaInformatico: 'VF', Version: '0.3.0',
      NumeroInstalacion: 'VF-TEST-0001',
      TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
    });
  });

  it('escapa los caracteres especiales y los recupera intactos', () => {
    const xml = serializarRegistroAlta(datosAlta());
    assert.ok(xml.includes('Peluquería Ñandú &amp; Hijos &lt;Centro&gt;'));
    assert.ok(xml.includes('Clínica Fisio &quot;Sol&quot; S.L.'));
    const { RegistroAlta: r } = leer(xml);
    assert.equal(r.NombreRazonEmisor, EMPRESA.nombreRazon);
    assert.equal(r.DescripcionOperacion, 'Servicios de peluquería & estética');
  });

  it('una operación exenta no lleva tipo ni cuota; una sujeta, sí', () => {
    const { RegistroAlta: r } = leer(serializarRegistroAlta(datosAlta()));
    const [sujeta, exenta] = r.Desglose.DetalleDesglose;
    assert.deepEqual(sujeta, {
      Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00',
      BaseImponibleOimporteNoSujeto: '100.00', CuotaRepercutida: '21.00',
    });
    assert.deepEqual(exenta, { Impuesto: '01', ClaveRegimen: '01', OperacionExenta: 'E1', BaseImponibleOimporteNoSujeto: '50.00' });
  });

  it('no escribe los campos opcionales que no proceden', () => {
    const xml = serializarRegistroAlta(datosAlta());
    for (const ausente of ['Subsanacion', 'RechazoPrevio', 'TipoRectificativa', 'FacturasRectificadas', 'ImporteRectificacion', 'FechaOperacion', 'Signature']) {
      assert.ok(!xml.includes(`:${ausente}>`), `no debería aparecer ${ausente}`);
    }
  });

  it('se niega a generar un registro inválido (no se podría corregir después)', () => {
    const rechaza = (datos: Parameters<typeof serializarRegistroAlta>[0], mensaje: RegExp) =>
      assert.throws(() => serializarRegistroAlta(datos), (e: unknown) => e instanceof ErrorDominio && mensaje.test(e.message));

    rechaza(datosAlta({ sistemaInformatico: { ...SIF, productor: { nombreRazon: null, nif: null } } }), /productor/);
    rechaza(datosAlta({ desglose: [] }), /desglose/);
    rechaza(datosAlta({ desglose: Array.from({ length: 13 }, () => desglose()) }), /desglose/);
    rechaza(datosAlta({ factura: factura({ tipoFactura: 'R1', tipoRectificativa: 'S' }) }), /sustitución/);
    rechaza(datosAlta({ factura: factura({ descripcionOperacion: 'x'.repeat(501) }) }), /500/);
    rechaza(datosAlta({ factura: factura({ descripcionOperacion: 'mal\u0001carácter' }) }), /caracteres de control/);
    // Un importe con más de dos decimales no se redondea en silencio.
    rechaza(datosAlta({ desglose: [desglose({ baseImponible: '100.001' })] }), /Importe no válido/);
  });
});

describe('RegistroAnulacion', () => {
  it('cumple el XSD oficial, también con «SinRegistroPrevio» y siendo el primero de la cadena', { skip: omitir }, () => {
    assert.equal(erroresXsd(serializarRegistroAnulacion(datosAnulacion()), 'SuministroInformacion.xsd'), null);
    assert.equal(
      erroresXsd(
        serializarRegistroAnulacion(
          datosAnulacion({ sinRegistroPrevio: true, rechazoPrevio: true, encadenamiento: { esPrimerRegistro: true, registroAnterior: null } })
        ),
        'SuministroInformacion.xsd'
      ),
      null
    );
  });

  it('identifica la factura anulada con los nombres de campo propios de la anulación', () => {
    const datos = datosAnulacion({ sinRegistroPrevio: true });
    const { RegistroAnulacion: r } = leer(serializarRegistroAnulacion(datos));
    assert.deepEqual(r.IDFactura, {
      IDEmisorFacturaAnulada: EMPRESA.nif, NumSerieFacturaAnulada: 'F26-000012', FechaExpedicionFacturaAnulada: '16-11-2026',
    });
    assert.equal(r.SinRegistroPrevio, 'S');
    assert.equal(r.RechazoPrevio, undefined);
    assert.equal(r.Huella, datos.huella);
    assert.equal(r.RefExterna, datos.registroId);
  });
});
