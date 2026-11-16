/**
 * Tests de integración de la Fase 3 (documentos).  →  pnpm test:db
 *
 * Recorren el camino completo contra PostgreSQL y con el rol acotado:
 *   borrador → emitirFactura (registro + huella + QR) → generarDocumentoFactura
 * y comprueban que la representación visual lleva los datos fiscales de la
 * factura y, incrustado, el MISMO QR que quedó en el registro de facturación.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { client, db } from '@/lib/db/drizzle';
import {
  facturas,
  facturasDesglose,
  facturasLineas,
  teamMembers,
  teams,
  users,
  type Empresa,
  type NewFactura,
  type SerieFacturacion,
} from '@/lib/db/schema';
import type { ContextoUsuario } from '../contexto';
import { fechaEnHuso } from '../crypto';
import { leerQrDelHtml, textoVisible } from '../documentos/__tests__/leer-qr';
import { generarDocumentoFactura } from '../documentos/servicio';
import { altaEmpresa } from '../empresas/servicio';
import { ErrorDominio, type CodigoError } from '../errores';
import { emitirFactura, type DependenciasEmision } from '../registros/servicio';

/* ------------------------------- utilidades -------------------------------- */

function dniAleatorio(): string {
  const numero = randomInt(10_000_000, 99_999_999);
  return `${numero}${'TRWAGMYFPDXBNJZSQVHLCKE'[numero % 23]}`;
}

async function crearCuenta(): Promise<ContextoUsuario> {
  const marca = `${Date.now()}-${randomInt(1e9)}`;
  const [usuario] = await db.insert(users).values({ email: `f3-${marca}@example.com`, passwordHash: 'x', role: 'owner' }).returning();
  const [cuenta] = await db.insert(teams).values({ name: `Cuenta ${marca}` }).returning();
  await db.insert(teamMembers).values({ userId: usuario.id, teamId: cuenta.id, role: 'owner' });
  return { usuarioId: usuario.id, teamId: cuenta.id, rol: 'owner', ip: '127.0.0.1' };
}

type LineaPrueba = { descripcion: string; cantidad: number; precio: number; tipo: number | null; exenta?: string };

/**
 * Borrador con líneas y desglose (lo que hará el futuro servicio de facturas).
 * Los importes se calculan en céntimos para que el test sepa qué esperar.
 */
async function crearBorrador(
  empresa: Empresa,
  serie: SerieFacturacion,
  lineas: LineaPrueba[],
  cabecera: Partial<NewFactura> = {}
): Promise<string> {
  const euros = (centimos: number) => (centimos / 100).toFixed(2);
  const calculadas = lineas.map((l) => {
    const base = Math.round(l.cantidad * l.precio * 100);
    return { ...l, base, cuota: l.tipo === null ? 0 : Math.round((base * l.tipo) / 100) };
  });
  const base = calculadas.reduce((s, l) => s + l.base, 0);
  const cuota = calculadas.reduce((s, l) => s + l.cuota, 0);
  const retencion = cabecera.retencionIrpfPorcentaje ? Math.round((base * Number(cabecera.retencionIrpfPorcentaje)) / 100) : 0;

  const [borrador] = await db
    .insert(facturas)
    .values({
      empresaId: empresa.id, serieId: serie.id, tipoFactura: 'F2', descripcionOperacion: 'Servicios',
      baseImponibleTotal: euros(base), cuotaTotal: euros(cuota), importeTotal: euros(base + cuota),
      retencionIrpfImporte: euros(retencion), totalAPagar: euros(base + cuota - retencion),
      ...cabecera,
    })
    .returning();

  await db.insert(facturasLineas).values(
    calculadas.map((l, i) => ({
      empresaId: empresa.id, facturaId: borrador.id, orden: i + 1, descripcion: l.descripcion,
      cantidad: l.cantidad.toFixed(3), precioUnitario: l.precio.toFixed(4), baseLinea: euros(l.base),
      calificacionOperacion: l.exenta ? null : 'S1', operacionExenta: l.exenta ?? null,
      tipoImpositivo: l.tipo === null ? null : l.tipo.toFixed(2), cuota: euros(l.cuota),
    }))
  );

  // Desglose: una fila por tipo impositivo (o por causa de exención).
  const grupos = new Map<string, { tipo: number | null; exenta?: string; base: number; cuota: number }>();
  for (const l of calculadas) {
    const clave = l.exenta ?? String(l.tipo);
    const grupo = grupos.get(clave) ?? { tipo: l.tipo, exenta: l.exenta, base: 0, cuota: 0 };
    grupo.base += l.base;
    grupo.cuota += l.cuota;
    grupos.set(clave, grupo);
  }
  await db.insert(facturasDesglose).values(
    [...grupos.values()].map((g) => ({
      empresaId: empresa.id, facturaId: borrador.id,
      calificacionOperacion: g.exenta ? null : 'S1', operacionExenta: g.exenta ?? null,
      tipoImpositivo: g.tipo === null ? null : g.tipo.toFixed(2),
      baseImponible: euros(g.base), cuotaRepercutida: g.exenta ? null : euros(g.cuota),
    }))
  );
  return borrador.id;
}

/** Sustituto del generador de XML, que llegará en la fase siguiente. */
const deps: DependenciasEmision = { serializarRegistroAlta: (d) => `<RegistroAlta><Huella>${d.huella}</Huella></RegistroAlta>` };

async function rechazaCon(codigo: CodigoError, promesa: Promise<unknown>, contiene?: RegExp) {
  await assert.rejects(promesa, (error: unknown) => {
    assert.ok(error instanceof ErrorDominio, `se esperaba ErrorDominio y llegó: ${error}`);
    assert.equal(error.codigo, codigo, error.message);
    if (contiene) assert.match(error.message, contiene);
    return true;
  });
}

const contiene = (texto: string, datos: string[]) => {
  for (const dato of datos) assert.ok(texto.includes(dato), `falta "${dato}" en el documento:\n${texto}`);
};
const enOrden = (texto: string, hitos: string[]) => {
  const posiciones = hitos.map((h) => texto.indexOf(h));
  assert.ok(posiciones.every((p) => p >= 0), `falta alguno de ${JSON.stringify(hitos)} en:\n${texto}`);
  assert.deepEqual(posiciones, [...posiciones].sort((a, b) => a - b), `orden incorrecto de ${JSON.stringify(hitos)}`);
};

/* --------------------------------- tests ----------------------------------- */

let A: ContextoUsuario;
let B: ContextoUsuario;

before(async () => {
  A = await crearCuenta();
  B = await crearCuenta();
});

after(async () => {
  await client.end();
});

describe('Al emitir un ticket (F2) se obtiene su representación con el QR del registro', () => {
  it('ticket de un bar: datos fiscales, desglose por tipos y QR legible', async () => {
    const { empresa, series } = await altaEmpresa(A, {
      nif: dniAleatorio(), nombreRazon: 'Bar La Esquina', direccion: 'Plaza Mayor 3', codigoPostal: '37001', municipio: 'Salamanca',
    });
    const tickets = series.find((s) => s.tipoSerie === 'SIMPLIFICADA')!;
    const borrador = await crearBorrador(empresa, tickets, [
      { descripcion: 'Menú del día', cantidad: 2, precio: 12, tipo: 10 },
      { descripcion: 'Botella de vino', cantidad: 1, precio: 10, tipo: 21 },
    ]);

    const { factura, registro } = await emitirFactura(A, empresa.id, borrador, deps);
    const documento = await generarDocumentoFactura(A, empresa.id, factura.id);
    const texto = textoVisible(documento.html);

    assert.equal(documento.formato, 'TICKET_80');
    assert.equal(documento.nombreArchivo, `ticket-${factura.numSerieFactura}.html`);

    // Datos fiscales: los de la factura emitida, con su número y su fecha reales.
    const [anio, mes, dia] = fechaEnHuso(new Date(), empresa.husoHorario).split('-');
    contiene(texto, [
      'Factura simplificada', factura.numSerieFactura!, `${dia}/${mes}/${anio}`,
      'Bar La Esquina', `NIF: ${empresa.nif}`, 'Plaza Mayor 3, 37001 Salamanca',
      'Menú del día', '26,40 €', 'Botella de vino', '12,10 €',
      'IVA 10 %', '24,00 €', '2,40 €', 'IVA 21 %', '10,00 €', '2,10 €',
      'TOTAL', '38,50 €', 'Impuestos incluidos',
    ]);

    // El QR incrustado: se lee, y lo leído es la URL guardada en el registro de alta.
    const qr = leerQrDelHtml(documento.html)!;
    assert.equal(qr.texto, registro.qrUrl);
    assert.equal(
      qr.texto,
      `https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=${empresa.nif}&numserie=${factura.numSerieFactura}&fecha=${dia}-${mes}-${anio}&importe=38.50`
    );

    // Tamaño (art. 21.1), zona de silencio y posición: lo primero del ticket, con su texto y su leyenda.
    assert.ok(qr.anchoMm >= 30 && qr.anchoMm <= 40 && qr.anchoMm === qr.altoMm, `QR de ${qr.anchoMm}×${qr.altoMm} mm`);
    assert.ok(documento.modelo.qr!.imagen.ladoSimboloMm >= 30);
    assert.equal(qr.zonaSilencio, 4);
    enOrden(texto, ['QR tributario:', '[QR]', 'VERI*FACTU', 'Bar La Esquina', factura.numSerieFactura!, 'Menú del día', 'TOTAL']);

    // Pie: sistema informático y declaración responsable.
    contiene(texto, ['Documento expedido con el sistema informático de facturación', 'Declaración responsable del sistema informático de facturación:']);
  });

  it('el mismo ticket en papel de 58 mm y en A4 lleva el mismo QR', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Peluquería Formatos' });
    const borrador = await crearBorrador(empresa, series.find((s) => s.tipoSerie === 'SIMPLIFICADA')!, [
      { descripcion: 'Corte', cantidad: 1, precio: 15, tipo: 21 },
    ]);
    const { factura, registro } = await emitirFactura(A, empresa.id, borrador, deps);

    for (const [formato, pagina] of [['ticket58', '58mm '], ['a4', 'A4 portrait'], ['TICKET_80', '80mm ']] as const) {
      const documento = await generarDocumentoFactura(A, empresa.id, factura.id, { formato });
      const qr = leerQrDelHtml(documento.html)!;
      assert.ok(documento.html.includes(`@page{size:${pagina}`), `${formato} debería imprimirse en ${pagina}`);
      assert.equal(qr.texto, registro.qrUrl, `QR distinto en formato ${formato}`);
      assert.ok(qr.anchoMm >= 30 && qr.anchoMm <= 40, `QR de ${qr.anchoMm} mm en ${formato}`);
    }
    // Generar el documento dos veces da exactamente el mismo resultado.
    const [uno, dos] = await Promise.all([generarDocumentoFactura(A, empresa.id, factura.id), generarDocumentoFactura(A, empresa.id, factura.id)]);
    assert.equal(uno.html, dos.html);
    await rechazaCon('VALIDACION', generarDocumentoFactura(A, empresa.id, factura.id, { formato: 'carta' }), /Formato/);
  });
});

describe('Al emitir una factura completa (F1) se obtiene su representación en A4', () => {
  it('fontanero con retención: emisor, destinatario, líneas, totales y QR', async () => {
    const { empresa, series } = await altaEmpresa(A, {
      nif: dniAleatorio(), nombreRazon: 'Luis Gómez Fontanería', direccion: 'Calle del Agua 9', codigoPostal: '50001', municipio: 'Zaragoza', provincia: 'Zaragoza',
    });
    const ordinaria = series.find((s) => s.tipoSerie === 'ORDINARIA')!;
    const borrador = await crearBorrador(
      empresa, ordinaria,
      [
        { descripcion: 'Sustitución de bajante', cantidad: 8, precio: 45, tipo: 21 },
        { descripcion: 'Tubería y accesorios', cantidad: 1, precio: 140, tipo: 21 },
      ],
      {
        tipoFactura: 'F1', descripcionOperacion: 'Reparación de fontanería', retencionIrpfPorcentaje: '15.00',
        destinatarioNombre: 'Comunidad de Propietarios Sol 4', destinatarioNif: 'H12345674', destinatarioDomicilio: 'Calle del Sol 4, 50002 Zaragoza',
      }
    );

    const { factura, registro } = await emitirFactura(A, empresa.id, borrador, deps);
    const documento = await generarDocumentoFactura(A, empresa.id, factura.id);
    const texto = textoVisible(documento.html);

    assert.equal(documento.formato, 'A4');
    assert.ok(documento.html.includes('@page{size:A4 portrait'));
    contiene(texto, [
      'Factura', factura.numSerieFactura!, 'Luis Gómez Fontanería', `NIF: ${empresa.nif}`, 'Calle del Agua 9, 50001 Zaragoza, Zaragoza',
      'Comunidad de Propietarios Sol 4', 'NIF: H12345674', 'Calle del Sol 4, 50002 Zaragoza',
      'Sustitución de bajante', '360,00 €', 'Tubería y accesorios', '140,00 €',
      'IVA 21 %', '500,00 €', '105,00 €', 'Total factura', '605,00 €',
      'Retención IRPF 15 %', '−75,00 €', 'Total a pagar', '530,00 €',
    ]);

    // El QR y el registro hablan del importe TOTAL de la factura (605,00), no del neto a pagar.
    const qr = leerQrDelHtml(documento.html)!;
    assert.equal(qr.texto, registro.qrUrl);
    assert.ok(qr.texto!.endsWith('&importe=605.00'));
    assert.equal(registro.importeTotal, '605.00');
    assert.ok(qr.anchoMm >= 30 && qr.anchoMm <= 40);

    // Lo primero de la hoja es el QR con su texto y la frase de factura verificable.
    enOrden(texto, ['QR tributario:', '[QR]', 'Factura verificable en la sede electrónica de la AEAT', 'Número', 'Emisor', 'Destinatario', 'Sustitución de bajante']);
  });

  it('clínica de fisioterapia: servicio exento con su mención', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Clínica Fisio Norte' });
    const borrador = await crearBorrador(
      empresa, series.find((s) => s.tipoSerie === 'ORDINARIA')!,
      [{ descripcion: 'Sesión de fisioterapia', cantidad: 3, precio: 40, tipo: null, exenta: 'E1' }],
      { tipoFactura: 'F1', destinatarioNombre: 'Marta Ruiz', destinatarioNif: '12345678Z' }
    );
    const { factura, registro } = await emitirFactura(A, empresa.id, borrador, deps);
    const documento = await generarDocumentoFactura(A, empresa.id, factura.id);

    contiene(textoVisible(documento.html), ['Sesión de fisioterapia', 'IVA exento', '120,00 €', 'Operación exenta de IVA (artículo 20 de la Ley 37/1992).']);
    assert.equal(registro.cuotaTotal, '0.00');
    assert.ok(leerQrDelHtml(documento.html)!.texto!.endsWith('&importe=120.00'));
  });
});

describe('Lo que el documento NO hace', () => {
  it('antes de emitir es un borrador sin QR; al emitir aparece el del registro', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Taller Antes y Después' });
    const borrador = await crearBorrador(empresa, series.find((s) => s.tipoSerie === 'SIMPLIFICADA')!, [
      { descripcion: 'Revisión', cantidad: 1, precio: 50, tipo: 21 },
    ]);

    const previo = await generarDocumentoFactura(A, empresa.id, borrador);
    assert.ok(textoVisible(previo.html).includes('BORRADOR · Documento sin validez fiscal'));
    assert.equal(leerQrDelHtml(previo.html), null);
    assert.equal(previo.modelo.qr, null);

    const { registro } = await emitirFactura(A, empresa.id, borrador, deps);
    const emitido = await generarDocumentoFactura(A, empresa.id, borrador);
    assert.ok(!textoVisible(emitido.html).includes('BORRADOR'));
    assert.equal(leerQrDelHtml(emitido.html)!.texto, registro.qrUrl);
    // El documento usa la foto fija del emisor guardada al emitir.
    assert.ok(textoVisible(emitido.html).includes('Taller Antes y Después'));
  });

  it('no enseña facturas de otra cuenta ni a través de otra empresa', async () => {
    const { empresa, series } = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Privada de A' });
    const otraDeA = await altaEmpresa(A, { nif: dniAleatorio(), nombreRazon: 'Otra de A' });
    const deB = await altaEmpresa(B, { nif: dniAleatorio(), nombreRazon: 'Empresa de B' });
    const borrador = await crearBorrador(empresa, series.find((s) => s.tipoSerie === 'SIMPLIFICADA')!, [
      { descripcion: 'Servicio', cantidad: 1, precio: 10, tipo: 21 },
    ]);
    const { factura } = await emitirFactura(A, empresa.id, borrador, deps);

    await rechazaCon('NO_ENCONTRADO', generarDocumentoFactura(B, empresa.id, factura.id));
    await rechazaCon('NO_ENCONTRADO', generarDocumentoFactura(B, deB.empresa.id, factura.id));
    await rechazaCon('NO_ENCONTRADO', generarDocumentoFactura(A, otraDeA.empresa.id, factura.id));
    await rechazaCon('NO_ENCONTRADO', generarDocumentoFactura(A, empresa.id, '00000000-0000-4000-8000-000000000000'));
    await rechazaCon('VALIDACION', generarDocumentoFactura(A, empresa.id, 'no-es-un-uuid'));
  });
});
