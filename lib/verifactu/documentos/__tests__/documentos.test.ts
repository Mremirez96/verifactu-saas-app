/**
 * Tests unitarios de la representación de documentos.  →  pnpm test
 * Sin base de datos: datos de ejemplo → modelo → HTML.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Factura, FacturaDesglose, FacturaLinea, RegistroVerifactu } from '@/lib/db/schema';
import { contenidoQr, urlQr, type ModoSif } from '../../crypto';
import { ErrorDominio } from '../../errores';
import { declaracionResponsable, mencionSif, TITULO_DECLARACION } from '../declaracion';
import type { DatosDocumento } from '../modelo';
import { imagenQr } from '../qr-svg';
import { renderizarDocumento } from '../renderizado';
import { leerQrDelHtml, textoVisible } from './leer-qr';

/* ------------------------------ datos de ejemplo --------------------------- */

const EMPRESA = 'aaaaaaaa-0000-4000-8000-000000000001';
const FACTURA = 'ffffffff-0000-4000-8000-000000000001';

function linea(cambios: Partial<FacturaLinea> = {}): FacturaLinea {
  return {
    id: crypto.randomUUID(), empresaId: EMPRESA, facturaId: FACTURA, orden: 1,
    descripcion: 'Corte y peinado', cantidad: '1.000', precioUnitario: '100.0000', descuentoPorcentaje: '0.00',
    baseLinea: '100.00', impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', operacionExenta: null,
    tipoImpositivo: '21.00', cuota: '21.00', tipoRecargoEquivalencia: null, cuotaRecargoEquivalencia: '0.00',
    ...cambios,
  };
}

function desglose(cambios: Partial<FacturaDesglose> = {}): FacturaDesglose {
  return {
    id: crypto.randomUUID(), empresaId: EMPRESA, facturaId: FACTURA,
    impuesto: '01', claveRegimen: '01', calificacionOperacion: 'S1', operacionExenta: null,
    tipoImpositivo: '21.00', baseImponible: '100.00', cuotaRepercutida: '21.00',
    tipoRecargoEquivalencia: null, cuotaRecargoEquivalencia: null,
    ...cambios,
  };
}

function factura(cambios: Partial<Factura> = {}): Factura {
  const ahora = new Date('2026-11-16T10:00:00Z');
  return {
    id: FACTURA, empresaId: EMPRESA, serieId: crypto.randomUUID(),
    numero: 1, numSerieFactura: 'T26-000001', tipoFactura: 'F2', tipoRectificativa: null,
    estado: 'EMITIDA', estadoCobro: 'PENDIENTE',
    fechaExpedicion: '2026-11-16', fechaOperacion: null, emitidaEn: ahora, anuladaEn: null, cobradaEn: null,
    clienteId: null, destinatarioNombre: null, destinatarioNif: null, destinatarioIdOtroCodigoPais: null,
    destinatarioIdOtroTipo: null, destinatarioIdOtroNumero: null, destinatarioDomicilio: null,
    emisorNif: '89890001K', emisorNombreRazon: 'Peluquería Ejemplo', emisorDomicilio: 'Calle Mayor 1, 28013 Madrid',
    descripcionOperacion: 'Servicios de peluquería',
    baseImponibleTotal: '100.00', cuotaTotal: '21.00', importeTotal: '121.00',
    retencionIrpfPorcentaje: null, retencionIrpfImporte: '0.00', totalAPagar: '121.00',
    baseRectificada: null, cuotaRectificada: null, cuotaRecargoRectificado: null,
    observaciones: null, creadaPor: null, createdAt: ahora, updatedAt: ahora,
    ...cambios,
  };
}

/** Registro de alta coherente con la factura (misma URL de QR que generó la emisión). */
function registro(f: Factura, modo: ModoSif = 'VERIFACTU', cambios: Partial<RegistroVerifactu> = {}): RegistroVerifactu {
  return {
    id: crypto.randomUUID(), empresaId: EMPRESA, facturaId: f.id, numSecuencia: 1, tipoRegistro: 'ALTA',
    esSubsanacion: false, rechazoPrevio: 'N', idEmisorFactura: f.emisorNif!, nombreRazonEmisor: f.emisorNombreRazon!,
    numSerieFactura: f.numSerieFactura!, fechaExpedicion: f.fechaExpedicion!, tipoFactura: f.tipoFactura,
    cuotaTotal: f.cuotaTotal, importeTotal: f.importeTotal, fechaHoraHusoGen: '2026-11-16T11:00:00+01:00',
    generadoEn: new Date('2026-11-16T10:00:00Z'), esPrimerRegistro: true, registroAnteriorId: null, huellaAnterior: null,
    tipoHuella: '01', huella: 'A'.repeat(64), modo, sifIdSistema: 'VF', sifVersion: '0.3.0', sifNumeroInstalacion: 'VF-1',
    xmlRegistro: '<x/>', xmlFirmado: modo === 'NO_VERIFACTU',
    qrUrl: urlQr({
      nif: f.emisorNif!, numSerieFactura: f.numSerieFactura!, fechaExpedicion: f.fechaExpedicion!,
      importeTotal: f.importeTotal, modo, entorno: 'pruebas',
    }),
    creadoPor: null, createdAt: new Date('2026-11-16T10:00:00Z'),
    ...cambios,
  };
}

function ticket(cambios: Partial<Factura> = {}): DatosDocumento {
  const f = factura(cambios);
  return { factura: f, lineas: [linea()], desglose: [desglose()], registroAlta: registro(f) };
}

function completa(): DatosDocumento {
  const f = factura({
    tipoFactura: 'F1', numSerieFactura: 'F26-000042', numero: 42, fechaOperacion: '2026-11-10',
    destinatarioNombre: 'Reformas García, S.L.', destinatarioNif: 'B12345674', destinatarioDomicilio: 'Av. del Puerto 7, 46021 Valencia',
    emisorNombreRazon: 'Ana Pérez Fontanería', baseImponibleTotal: '1500.00', cuotaTotal: '315.00', importeTotal: '1815.00',
    retencionIrpfPorcentaje: '15.00', retencionIrpfImporte: '225.00', totalAPagar: '1590.00',
    observaciones: 'Pago por transferencia a 30 días.',
  });
  return {
    factura: f,
    lineas: [
      linea({ orden: 2, descripcion: 'Material', cantidad: '2.500', precioUnitario: '200.0000', baseLinea: '500.00', cuota: '105.00' }),
      linea({ orden: 1, descripcion: 'Mano de obra', cantidad: '20.000', precioUnitario: '50.0000', baseLinea: '1000.00', cuota: '210.00' }),
    ],
    desglose: [desglose({ baseImponible: '1500.00', cuotaRepercutida: '315.00' })],
    registroAlta: registro(f),
  };
}

const rechaza = (codigo: string, fn: () => unknown) =>
  assert.throws(fn, (e: unknown) => e instanceof ErrorDominio && e.codigo === codigo);

/* ---------------------------------- tests ---------------------------------- */

describe('Imagen del código QR', () => {
  const contenido = contenidoQr({
    nif: '89890001K', numSerieFactura: '12345678/G33', fechaExpedicion: '2024-01-01',
    importeTotal: '241.40', modo: 'VERIFACTU', entorno: 'produccion',
  });

  it('un lector de QR independiente lee exactamente la URL de cotejo', () => {
    const leido = leerQrDelHtml(imagenQr(contenido).svg)!;
    assert.equal(leido.texto, contenido.url);
  });

  it('mide entre 30 y 40 mm, es cuadrado y lleva su zona de silencio de 4 módulos', () => {
    const imagen = imagenQr(contenido);
    const leido = leerQrDelHtml(imagen.svg)!;
    assert.match(imagen.svg, /width="[\d.]+mm" height="[\d.]+mm"/);
    assert.equal(leido.anchoMm, leido.altoMm);
    assert.equal(leido.anchoMm, imagen.ladoTotalMm);
    assert.ok(imagen.ladoSimboloMm >= 30, `símbolo de ${imagen.ladoSimboloMm} mm`);
    assert.ok(imagen.ladoTotalMm <= 40, `imagen de ${imagen.ladoTotalMm} mm`);
    assert.equal(leido.zonaSilencio, 4);
    assert.equal(leido.modulosTotales, imagen.modulos + 8);
  });

  it('respeta los límites aunque se le pida otro tamaño', () => {
    const pequeno = imagenQr(contenido, { ladoSimboloMm: 10 });
    const enorme = imagenQr(contenido, { ladoSimboloMm: 90 });
    assert.equal(pequeno.ladoSimboloMm, 30);
    assert.ok(enorme.ladoTotalMm <= 40 && enorme.ladoSimboloMm >= 30);
  });

  it('usa el nivel M de corrección: sigue leyéndose con parte del símbolo tapada', () => {
    const imagen = imagenQr(contenido);
    assert.equal(contenido.nivelCorreccion, 'M');
    // Se tapa con una mancha negra un recuadro del 5 % del símbolo, lejos de las esquinas.
    const lado = Math.floor(imagen.modulos * 0.22);
    const origen = Math.floor(imagen.modulos / 2) + 4;
    const mancha = Array.from({ length: lado }, (_, i) => `M${origen} ${origen + i}h${lado}v1h-${lado}z`).join('');
    const danado = imagen.svg.replace(' d="', ` d="${mancha}`);
    assert.notEqual(danado, imagen.svg);
    assert.equal(leerQrDelHtml(danado)!.texto, contenido.url);
  });
});

describe('Ticket (factura simplificada F2)', () => {
  const { html, formato, nombreArchivo } = renderizarDocumento(ticket());
  const texto = textoVisible(html);

  it('sale por defecto en papel de 80 mm y es un HTML autosuficiente', () => {
    assert.equal(formato, 'TICKET_80');
    assert.equal(nombreArchivo, 'ticket-T26-000001.html');
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /@page\{size:80mm \d+mm;margin:4mm/);
    assert.doesNotMatch(html, /<script|<link|<img|src=|url\(/i);
  });

  it('contiene los datos fiscales obligatorios de una simplificada', () => {
    for (const dato of ['Factura simplificada', 'T26-000001', '16/11/2026', 'Peluquería Ejemplo', 'NIF: 89890001K',
      'Corte y peinado', 'IVA 21 %', '121,00 €', 'Impuestos incluidos', '100,00 €', '21,00 €']) {
      assert.ok(texto.includes(dato), `falta "${dato}" en: ${texto}`);
    }
    assert.ok(!texto.includes('Cliente:'), 'una simplificada sin destinatario no muestra bloque de cliente');
  });

  it('el QR va al principio, entre «QR tributario:» y la leyenda VERI*FACTU', () => {
    const posiciones = ['QR tributario:', '[QR]', 'VERI*FACTU', 'Peluquería Ejemplo', 'T26-000001'].map((t) => texto.indexOf(t));
    assert.ok(posiciones.every((p) => p >= 0), texto);
    assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b), 'orden: texto, QR, leyenda y después el contenido');
    assert.match(html, /<p class="qr-leyenda">VERI\*FACTU<\/p>/);
  });

  it('el QR incrustado es el del registro y cumple el tamaño', () => {
    const datos = ticket();
    const leido = leerQrDelHtml(renderizarDocumento(datos).html)!;
    assert.equal(leido.texto, datos.registroAlta!.qrUrl);
    assert.ok(leido.anchoMm >= 30 && leido.anchoMm <= 40);
  });

  it('en papel de 58 mm el QR sigue cabiendo y cumpliendo', () => {
    const doc = renderizarDocumento(ticket(), 'TICKET_58');
    const leido = leerQrDelHtml(doc.html)!;
    assert.match(doc.html, /@page\{size:58mm \d+mm;margin:2mm/);
    assert.ok(doc.modelo.qr!.imagen.ladoSimboloMm >= 30);
    assert.ok(leido.anchoMm <= 40 && leido.anchoMm <= 58 - 2 * 2, `QR de ${leido.anchoMm} mm en 54 mm útiles`);
    assert.equal(leido.texto, doc.modelo.qr!.contenido.url);
  });
});

describe('Factura completa (F1) en A4', () => {
  const datos = completa();
  const { html, formato, nombreArchivo } = renderizarDocumento(datos);
  const texto = textoVisible(html);

  it('sale en A4 con emisor, destinatario, líneas, desglose y totales', () => {
    assert.equal(formato, 'A4');
    assert.equal(nombreArchivo, 'factura-F26-000042.html');
    assert.match(html, /@page\{size:A4 portrait/);
    for (const dato of ['Factura', 'F26-000042', '16/11/2026', 'Fecha de operación', '10/11/2026',
      'Ana Pérez Fontanería', 'NIF: 89890001K', 'Reformas García, S.L.', 'NIF: B12345674', 'Av. del Puerto 7, 46021 Valencia',
      'Mano de obra', 'Material', '2,5', '1500,00 €', '315,00 €', '1815,00 €',
      'Retención IRPF 15 %', '−225,00 €', 'Total a pagar', '1590,00 €', 'Pago por transferencia a 30 días.']) {
      assert.ok(texto.includes(dato), `falta "${dato}" en: ${texto}`);
    }
    // Las líneas salen en su orden, no en el de lectura de la base de datos.
    assert.ok(texto.indexOf('Mano de obra') < texto.indexOf('Material'));
  });

  it('el QR abre el documento y lleva la frase larga de factura verificable', () => {
    const orden = ['QR tributario:', '[QR]', 'Factura verificable en la sede electrónica de la AEAT', 'Emisor', 'Destinatario']
      .map((t) => texto.indexOf(t));
    assert.ok(orden.every((p) => p >= 0), texto);
    assert.deepEqual(orden, [...orden].sort((a, b) => a - b));
    assert.equal(leerQrDelHtml(html)!.texto, datos.registroAlta!.qrUrl);
  });

  it('una F1 también puede imprimirse como ticket y una F2 en A4', () => {
    assert.equal(renderizarDocumento(datos, 'TICKET_80').formato, 'TICKET_80');
    assert.ok(textoVisible(renderizarDocumento(datos, 'TICKET_80').html).includes('Cliente: Reformas García, S.L.'));
    assert.equal(renderizarDocumento(ticket(), 'A4').formato, 'A4');
  });
});

describe('Menciones y estados', () => {
  it('servicio exento (p. ej. fisioterapia): indica la exención y no muestra cuota', () => {
    const f = factura({ baseImponibleTotal: '45.00', cuotaTotal: '0.00', importeTotal: '45.00', totalAPagar: '45.00' });
    const exenta = { calificacionOperacion: null, operacionExenta: 'E1', tipoImpositivo: null };
    const texto = textoVisible(
      renderizarDocumento({
        factura: f,
        lineas: [linea({ descripcion: 'Sesión de fisioterapia', precioUnitario: '45.0000', baseLinea: '45.00', cuota: '0.00', ...exenta })],
        desglose: [desglose({ baseImponible: '45.00', cuotaRepercutida: null, ...exenta })],
        registroAlta: registro(f),
      }).html
    );
    assert.ok(texto.includes('IVA exento'));
    assert.ok(texto.includes('Operación exenta de IVA (artículo 20 de la Ley 37/1992).'));
    assert.ok(texto.includes('45,00 €'));
  });

  it('recargo de equivalencia e inversión del sujeto pasivo', () => {
    const datos = completa();
    datos.desglose = [
      desglose({ baseImponible: '1000.00', cuotaRepercutida: '210.00', tipoRecargoEquivalencia: '5.20', cuotaRecargoEquivalencia: '52.00' }),
      desglose({ baseImponible: '500.00', cuotaRepercutida: null, calificacionOperacion: 'S2', tipoImpositivo: null }),
    ];
    const texto = textoVisible(renderizarDocumento(datos).html);
    assert.ok(texto.includes('Recargo de equivalencia 5,2 %'));
    assert.ok(texto.includes('52,00 €'));
    assert.ok(texto.includes('Inversión del sujeto pasivo.'));
  });

  it('NO VERI*FACTU: lleva QR (al servicio de no verificables) pero NO la frase de factura verificable', () => {
    const f = factura();
    const doc = renderizarDocumento({ factura: f, lineas: [linea()], desglose: [desglose()], registroAlta: registro(f, 'NO_VERIFACTU') });
    assert.match(leerQrDelHtml(doc.html)!.texto!, /\/ValidarQRNoVerifactu\?nif=89890001K/);
    assert.ok(textoVisible(doc.html).includes('QR tributario:'));
    assert.doesNotMatch(doc.html, /class="qr-leyenda"/);
    assert.doesNotMatch(doc.html, /Factura verificable/);
  });

  it('un borrador se previsualiza marcado como tal y sin QR', () => {
    const doc = renderizarDocumento({
      factura: factura({ estado: 'BORRADOR', numero: null, numSerieFactura: null, emitidaEn: null }),
      lineas: [linea()], desglose: [desglose()], registroAlta: null,
    });
    const texto = textoVisible(doc.html);
    assert.ok(texto.includes('BORRADOR · Documento sin validez fiscal'));
    assert.equal(leerQrDelHtml(doc.html), null);
    assert.ok(!texto.includes('QR tributario'));
    assert.equal(doc.nombreArchivo, 'ticket-borrador.html');
  });

  it('una factura anulada conserva su QR y avisa de la anulación', () => {
    const doc = renderizarDocumento(ticket({ estado: 'ANULADA', anuladaEn: new Date() }));
    assert.ok(textoVisible(doc.html).includes('FACTURA ANULADA'));
    assert.ok(leerQrDelHtml(doc.html)!.texto);
  });
});

describe('Seguridad e integridad del documento', () => {
  it('escapa cualquier marcado que venga en los datos de la factura', () => {
    const datos = ticket({ emisorNombreRazon: 'Bar "El <b>Rincón</b>" & Cía', observaciones: "<img src=x onerror='alert(1)'>" });
    datos.lineas = [linea({ descripcion: '<script>alert(1)</script>' })];
    const { html } = renderizarDocumento(datos);
    assert.doesNotMatch(html, /<script|<img|<b>|onerror='/);
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Bar &quot;El &lt;b&gt;Rincón&lt;/b&gt;&quot; &amp; Cía'));
    // Y el lector sigue viendo el texto original, tal cual se escribió.
    assert.ok(textoVisible(html).includes('Bar "El <b>Rincón</b>" & Cía'));
  });

  it('se niega a imprimir si el QR del registro no corresponde a los datos de la factura', () => {
    const datos = ticket();
    datos.registroAlta = { ...datos.registroAlta!, qrUrl: datos.registroAlta!.qrUrl!.replace('importe=121.00', 'importe=12.10') };
    rechaza('INTEGRIDAD', () => renderizarDocumento(datos));
    // Igual si alguien cambiara el importe de la factura y no el registro.
    const otra = ticket();
    otra.factura = { ...otra.factura, importeTotal: '12.10' };
    rechaza('INTEGRIDAD', () => renderizarDocumento(otra));
  });

  it('una factura emitida sin registro de alta no se representa', () => {
    rechaza('INTEGRIDAD', () => renderizarDocumento({ ...ticket(), registroAlta: null }));
  });

  it('rectificativas y sustitutivas: todavía no, y lo dice', () => {
    rechaza('VALIDACION', () => renderizarDocumento(ticket({ tipoFactura: 'R1', tipoRectificativa: 'I' })));
    rechaza('VALIDACION', () => renderizarDocumento(ticket({ tipoFactura: 'F3' })));
  });
});

describe('Declaración responsable del SIF', () => {
  const VARIABLES = {
    VERIFACTU_PRODUCTOR_NOMBRE: 'Productora de Ejemplo, S.L.',
    VERIFACTU_PRODUCTOR_NIF: 'B12345674',
    VERIFACTU_PRODUCTOR_DIRECCION: 'Calle de la Prueba 1, 28001 Madrid, España',
    VERIFACTU_DECLARACION_FECHA: '16 de noviembre de 2026',
    VERIFACTU_DECLARACION_LUGAR: 'Madrid, España',
  };
  const conEntorno = <T>(variables: Record<string, string | undefined>, fn: () => T): T => {
    const previas = Object.fromEntries(Object.keys(VARIABLES).map((k) => [k, process.env[k]]));
    for (const k of Object.keys(VARIABLES)) delete process.env[k];
    Object.assign(process.env, Object.fromEntries(Object.entries(variables).filter(([, v]) => v !== undefined)));
    try {
      return fn();
    } finally {
      for (const [k, v] of Object.entries(previas)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  };

  it('tiene el título literal y los doce apartados del art. 15.1, en orden', () => {
    const declaracion = conEntorno(VARIABLES, declaracionResponsable);
    assert.equal(declaracion.titulo, 'DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN');
    assert.equal(TITULO_DECLARACION, declaracion.titulo);
    assert.equal(declaracion.apartados.map((a) => a.letra).join(''), 'abcdefghijkl');
    assert.equal(declaracion.completa, true);
    const porLetra = Object.fromEntries(declaracion.apartados.map((a) => [a.letra, a.valor]));
    assert.equal(porLetra.i, 'B12345674');
    assert.match(porLetra.k!, /artículo 29\.2\.j\) de la Ley 58\/2003.*Real Decreto 1007\/2023.*Orden HAC\/1177\/2024/);
    assert.equal(porLetra.l, '16 de noviembre de 2026. Madrid, España');
  });

  it('sin los datos del productor se declara INCOMPLETA en vez de inventarlos', () => {
    const declaracion = conEntorno({}, declaracionResponsable);
    assert.equal(declaracion.completa, false);
    assert.deepEqual(declaracion.pendientes.map((p) => p[0]), ['h', 'i', 'j', 'k', 'l']);
    // Los datos del sistema sí están: no dependen del productor.
    assert.ok(declaracion.apartados.slice(0, 7).every((a) => a.valor));
  });

  it('el pie de los documentos identifica el sistema y remite a la declaración', () => {
    const [sistema, enlace] = conEntorno(VARIABLES, () => mencionSif('https://app.example.com/'));
    assert.match(sistema, /sistema informático de facturación .+ \(VF\), versión \d+\.\d+\.\d+, producido por Productora de Ejemplo, S\.L\. \(NIF B12345674\)\./);
    assert.equal(enlace, 'Declaración responsable del sistema informático de facturación: https://app.example.com/declaracion-responsable');

    const texto = textoVisible(renderizarDocumento(ticket()).html);
    assert.ok(texto.includes('Documento expedido con el sistema informático de facturación'));
    assert.ok(texto.includes('Declaración responsable del sistema informático de facturación:'));
  });
});
