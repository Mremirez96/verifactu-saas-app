/**
 * Tests de integración de la Fase 2 (motor criptográfico).  →  pnpm test:db
 *
 * Contra PostgreSQL real y con el rol acotado de la aplicación: comprueban que
 * el cálculo de la huella y la inserción del registro quedan aislados por
 * `vf_bloquear_cadena` también cuando hay emisiones simultáneas.
 * (La ruptura matemática de la cadena se demuestra, sin base de datos, en
 * lib/verifactu/crypto/__tests__/cadena.test.ts.)
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { client, db } from '@/lib/db/drizzle';
import {
  enviosAeat,
  facturas,
  facturasLineas,
  seriesFacturacion,
  teamMembers,
  teams,
  users,
  type Empresa,
  type SerieFacturacion,
} from '@/lib/db/schema';
import type { ContextoUsuario } from '../contexto';
import { fechaEnHuso, huellaRegistroAlta, recalcularHuella, urlQr } from '../crypto';
import { leerCadenas } from '../empresas/repositorio';
import { altaEmpresa } from '../empresas/servicio';
import { ErrorDominio, type CodigoError } from '../errores';
import { bloquearCadena, listarCadena } from '../registros/repositorio';
import {
  emitirFactura,
  verificarCadenaEmpresa,
  type DatosRegistroAlta,
  type DependenciasEmision,
} from '../registros/servicio';

/* ------------------------------- utilidades -------------------------------- */

function dniAleatorio(): string {
  const numero = randomInt(10_000_000, 99_999_999);
  return `${numero}${'TRWAGMYFPDXBNJZSQVHLCKE'[numero % 23]}`;
}

async function crearCuenta(): Promise<ContextoUsuario> {
  const marca = `${Date.now()}-${randomInt(1e9)}`;
  const [usuario] = await db.insert(users).values({ email: `f2-${marca}@example.com`, passwordHash: 'x', role: 'owner' }).returning();
  const [cuenta] = await db.insert(teams).values({ name: `Cuenta ${marca}` }).returning();
  await db.insert(teamMembers).values({ userId: usuario.id, teamId: cuenta.id, role: 'owner' });
  return { usuarioId: usuario.id, teamId: cuenta.id, rol: 'owner', ip: '127.0.0.1' };
}

/** Borrador mínimo (lo que en su día creará el servicio de facturas). */
async function crearBorrador(empresa: Empresa, serie: SerieFacturacion, base = 100): Promise<string> {
  const cuota = (base * 0.21).toFixed(2);
  const total = (base * 1.21).toFixed(2);
  const [borrador] = await db
    .insert(facturas)
    .values({
      empresaId: empresa.id, serieId: serie.id, tipoFactura: 'F2', descripcionOperacion: 'Servicios',
      baseImponibleTotal: base.toFixed(2), cuotaTotal: cuota, importeTotal: total, totalAPagar: total,
    })
    .returning();
  await db.insert(facturasLineas).values({
    empresaId: empresa.id, facturaId: borrador.id, orden: 1, descripcion: 'Servicio',
    precioUnitario: base.toFixed(2), baseLinea: base.toFixed(2), calificacionOperacion: 'S1', tipoImpositivo: '21.00', cuota,
  });
  return borrador.id;
}

/** Sustituto del generador de XML (fase siguiente): solo para los tests. */
const capturados: DatosRegistroAlta[] = [];
const deps: DependenciasEmision = {
  serializarRegistroAlta: (datos) => {
    capturados.push(datos);
    return `<RegistroAlta><Huella>${datos.huella}</Huella></RegistroAlta>`;
  },
};

async function rechazaCon(codigo: CodigoError, promesa: Promise<unknown>, contiene?: RegExp) {
  await assert.rejects(promesa, (error: unknown) => {
    assert.ok(error instanceof ErrorDominio, `se esperaba ErrorDominio y llegó: ${error}`);
    assert.equal(error.codigo, codigo, error.message);
    if (contiene) assert.match(error.message, contiene);
    return true;
  });
}

async function nuevaEmpresa(ctx: ContextoUsuario, nombre: string) {
  const { empresa, series } = await altaEmpresa(ctx, { nif: dniAleatorio(), nombreRazon: nombre });
  return { empresa, tickets: series.find((s) => s.tipoSerie === 'SIMPLIFICADA')! };
}

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

describe('Emisión con registro de alta encadenado', () => {
  it('primer registro: huella oficial, QR y cola de envío', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Huella');
    const borrador = await crearBorrador(empresa, tickets, 100);

    const { factura, registro, qr } = await emitirFactura(A, empresa.id, borrador, deps);

    // La factura: número asignado por la BD y fecha del día en el huso de la empresa.
    assert.equal(factura.estado, 'EMITIDA');
    assert.equal(factura.numSerieFactura, `${tickets.codigo}000001`);
    assert.equal(factura.fechaExpedicion, fechaEnHuso(new Date(), empresa.husoHorario));
    assert.equal(factura.emisorNif, empresa.nif);

    // El registro: primero de la cadena, con la huella que da el algoritmo de la AEAT.
    assert.equal(registro.numSecuencia, 1);
    assert.equal(registro.esPrimerRegistro, true);
    assert.equal(registro.huellaAnterior, null);
    assert.match(registro.fechaHoraHusoGen, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+0[12]:00$/);
    assert.equal(
      registro.huella,
      huellaRegistroAlta({
        idEmisorFactura: empresa.nif,
        numSerieFactura: factura.numSerieFactura!,
        fechaExpedicion: factura.fechaExpedicion!,
        tipoFactura: 'F2',
        cuotaTotal: '21.00',
        importeTotal: '121.00',
        huellaAnterior: null,
        fechaHoraHusoGen: registro.fechaHoraHusoGen,
      })
    );
    // La fecha-hora guardada como texto y el timestamptz derivado son el mismo instante.
    assert.equal(Date.parse(registro.fechaHoraHusoGen), registro.generadoEn.getTime());

    // El QR: misma URL en el resultado, en el registro y recalculada.
    const esperada = urlQr({
      nif: empresa.nif, numSerieFactura: factura.numSerieFactura!, fechaExpedicion: factura.fechaExpedicion!,
      importeTotal: '121.00', modo: 'VERIFACTU', entorno: 'pruebas',
    });
    assert.equal(qr.url, esperada);
    assert.equal(registro.qrUrl, esperada);
    assert.ok(esperada.startsWith('https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif='));
    assert.equal(qr.leyenda?.corta, 'VERI*FACTU');

    // El generador de XML recibió huella y encadenamiento ya calculados.
    const enviado = capturados.at(-1)!;
    assert.equal(enviado.huella, registro.huella);
    assert.deepEqual(enviado.encadenamiento, { esPrimerRegistro: true, registroAnterior: null });
    assert.equal(enviado.sistemaInformatico.numeroInstalacion, empresa.numeroInstalacion);

    // Efectos de los triggers: cola de envío y cabecera de la cadena.
    const cola = await db.select().from(enviosAeat).where(eq(enviosAeat.registroId, registro.id));
    assert.deepEqual(cola.map((e) => e.estado), ['PENDIENTE']);
    const cabecera = (await leerCadenas(db, empresa.id)).find((c) => c.tipoCadena === 'FACTURACION')!;
    assert.equal(cabecera.ultimaHuella, registro.huella);
    assert.equal(cabecera.ultimoId, registro.id);
  });

  it('el segundo registro lleva dentro la huella del primero', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Cadena');
    const r1 = (await emitirFactura(A, empresa.id, await crearBorrador(empresa, tickets, 50), deps)).registro;
    const r2 = (await emitirFactura(A, empresa.id, await crearBorrador(empresa, tickets, 80), deps)).registro;

    assert.equal(r2.numSecuencia, 2);
    assert.equal(r2.esPrimerRegistro, false);
    assert.equal(r2.registroAnteriorId, r1.id);
    assert.equal(r2.huellaAnterior, r1.huella);
    assert.equal(recalcularHuella(r2), r2.huella);
    // Con otra huella anterior, la del segundo sería distinta: de ahí el encadenamiento.
    assert.notEqual(recalcularHuella({ ...r2, huellaAnterior: r2.huella }), r2.huella);

    assert.deepEqual(capturados.at(-1)!.encadenamiento, {
      esPrimerRegistro: false,
      registroAnterior: {
        idEmisorFactura: r1.idEmisorFactura, numSerieFactura: r1.numSerieFactura,
        fechaExpedicion: r1.fechaExpedicion, huella: r1.huella,
      },
    });

    const verificacion = await verificarCadenaEmpresa(A, empresa.id);
    assert.deepEqual(
      { integra: verificacion.integra, n: verificacion.registrosVerificados, ultima: verificacion.ultimaHuella },
      { integra: true, n: 2, ultima: r2.huella }
    );
  });

  it('rechaza reemitir, facturas ajenas y accesos de otra cuenta', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Fontanería Rechazos');
    const otra = await nuevaEmpresa(A, 'Otra empresa de A');
    const borrador = await crearBorrador(empresa, tickets);

    await emitirFactura(A, empresa.id, borrador, deps);
    await rechazaCon('CONFLICTO', emitirFactura(A, empresa.id, borrador, deps), /ya está emitida/);
    await rechazaCon('NO_ENCONTRADO', emitirFactura(A, empresa.id, '00000000-0000-4000-8000-000000000000', deps));
    // Una factura de la empresa X no se emite "a través" de la empresa Y, aunque sean de la misma cuenta.
    await rechazaCon('NO_ENCONTRADO', emitirFactura(A, otra.empresa.id, await crearBorrador(empresa, tickets), deps));
    await rechazaCon('NO_ENCONTRADO', emitirFactura(B, empresa.id, await crearBorrador(empresa, tickets), deps));
    await rechazaCon('NO_ENCONTRADO', verificarCadenaEmpresa(B, empresa.id));

    assert.equal((await verificarCadenaEmpresa(A, empresa.id)).registrosVerificados, 1);
  });

  it('si algo falla a mitad, no queda ni número, ni eslabón, ni factura emitida', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Rollback');
    await emitirFactura(A, empresa.id, await crearBorrador(empresa, tickets), deps);
    const borrador = await crearBorrador(empresa, tickets);

    // El generador de XML falla DESPUÉS de que la BD haya asignado el número 2.
    await assert.rejects(
      emitirFactura(A, empresa.id, borrador, { serializarRegistroAlta: () => { throw new Error('XML roto'); } }),
      /XML roto/
    );
    await rechazaCon('INTEGRIDAD', emitirFactura(A, empresa.id, borrador, { serializarRegistroAlta: () => '  ' }));

    const [factura] = await db.select().from(facturas).where(eq(facturas.id, borrador));
    assert.deepEqual([factura.estado, factura.numero, factura.numSerieFactura], ['BORRADOR', null, null]);
    const [serie] = await db.select().from(seriesFacturacion).where(eq(seriesFacturacion.id, tickets.id));
    assert.equal(serie.ultimoNumero, 1);
    assert.equal((await listarCadena(db, empresa.id)).length, 1);

    // El siguiente intento correcto recibe el número 2: no ha quedado hueco.
    const { factura: emitida, registro } = await emitirFactura(A, empresa.id, borrador, deps);
    assert.equal(emitida.numero, 2);
    assert.equal(registro.numSecuencia, 2);
  });
});

describe('Aislamiento de la cadena con vf_bloquear_cadena', () => {
  it('emisiones simultáneas: una cadena lineal por empresa, sin huecos ni bifurcaciones', async () => {
    const x = await nuevaEmpresa(A, 'Concurrencia X');
    const y = await nuevaEmpresa(B, 'Concurrencia Y');
    const borradoresX = await Promise.all(Array.from({ length: 12 }, (_, i) => crearBorrador(x.empresa, x.tickets, 10 + i)));
    const borradoresY = await Promise.all(Array.from({ length: 6 }, (_, i) => crearBorrador(y.empresa, y.tickets, 20 + i)));

    // 18 emisiones lanzadas a la vez, de dos empresas distintas.
    const resultados = await Promise.all([
      ...borradoresX.map((id) => emitirFactura(A, x.empresa.id, id, deps)),
      ...borradoresY.map((id) => emitirFactura(B, y.empresa.id, id, deps)),
    ]);
    assert.equal(resultados.length, 18);

    for (const [ctx, empresa, total] of [[A, x.empresa, 12], [B, y.empresa, 6]] as const) {
      const cadena = await listarCadena(db, empresa.id);

      // Secuencia 1..n y numeración 1..n: nadie obtuvo el mismo número ni se saltó ninguno.
      assert.deepEqual(cadena.map((r) => r.numSecuencia), Array.from({ length: total }, (_, i) => i + 1));
      const numeros = cadena.map((r) => Number(r.numSerieFactura.slice(-6))).sort((a, b) => a - b);
      assert.deepEqual(numeros, Array.from({ length: total }, (_, i) => i + 1));

      // Cada emisión leyó la huella que dejó la anterior: no hay dos registros con el mismo padre.
      cadena.forEach((registro, i) => {
        assert.equal(registro.huellaAnterior, i === 0 ? null : cadena[i - 1].huella);
        assert.equal(registro.empresaId, empresa.id);
      });
      assert.equal(new Set(cadena.map((r) => r.huellaAnterior)).size, total);

      // El tiempo no retrocede a lo largo de la cadena.
      for (let i = 1; i < cadena.length; i++) {
        assert.ok(cadena[i].generadoEn.getTime() >= cadena[i - 1].generadoEn.getTime());
      }

      const verificacion = await verificarCadenaEmpresa(ctx, empresa.id);
      assert.equal(verificacion.integra, true, JSON.stringify(verificacion.anomalias));
      assert.equal(verificacion.registrosVerificados, total);
    }
  });

  it('mientras alguien tiene el cerrojo, otra emisión de esa empresa espera; las de otras, no', async () => {
    const x = await nuevaEmpresa(A, 'Cerrojo X');
    const z = await nuevaEmpresa(A, 'Cerrojo Z');
    const borradorX = await crearBorrador(x.empresa, x.tickets);
    const borradorZ = await crearBorrador(z.empresa, z.tickets);

    await db.transaction(async (tx) => {
      const cabecera = await bloquearCadena(tx, x.empresa.id, 'FACTURACION');
      assert.deepEqual(cabecera, { ultimoId: null, ultimaHuella: null, ultimoNumSecuencia: 0 });

      // Misma empresa: no puede entrar; agota su espera y se le pide reintentar.
      await rechazaCon(
        'CONFLICTO',
        emitirFactura(A, x.empresa.id, borradorX, { ...deps, esperaCerrojoMs: 250 }),
        /otra emisión en curso/
      );
      // Otra empresa: emite sin enterarse.
      const { registro } = await emitirFactura(A, z.empresa.id, borradorZ, { ...deps, esperaCerrojoMs: 250 });
      assert.equal(registro.numSecuencia, 1);
    });

    // Liberado el cerrojo, la emisión que esperaba entra y es el primer eslabón.
    const { registro } = await emitirFactura(A, x.empresa.id, borradorX, deps);
    assert.equal(registro.numSecuencia, 1);
    assert.equal(registro.esPrimerRegistro, true);
  });

  it('el cerrojo solo se puede pedir dentro de una transacción (lo impide el compilador)', async () => {
    const x = await nuevaEmpresa(A, 'Cerrojo Tipos');
    // @ts-expect-error  `db` no es una transacción: esta línea no compila sin la directiva.
    const fueraDeTransaccion = () => bloquearCadena(db, x.empresa.id, 'FACTURACION');
    assert.equal(typeof fueraDeTransaccion, 'function'); // no se ejecuta: basta con que no compile

    // Y la app no puede bloquear ni escribir la cabecera por su cuenta.
    await assert.rejects(db.execute(sql`SELECT * FROM cadenas_fiscales WHERE empresa_id = ${x.empresa.id} FOR UPDATE`), /permission denied/);
  });
});
