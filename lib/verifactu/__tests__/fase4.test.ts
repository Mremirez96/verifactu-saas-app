/**
 * Tests de integración de la Fase 4 (conectividad con la AEAT).  →  pnpm test:db
 *
 * Contra PostgreSQL real, con el rol acotado de la aplicación, y contra un
 * SIMULADOR local de los servicios web de la AEAT (aeat/__tests__/simulador-aeat.ts)
 * al que se llega con el cliente HTTP de verdad. Recorren el camino completo:
 *
 *   borrador → emitirFactura (registro + huella + XML real) → cola → SOAP → respuesta → estados
 *
 * El tiempo se controla con un reloj falso que solo avanza cuando el test lo
 * dice: así se prueban esperas de minutos y horas en milisegundos.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import net from 'node:net';
import { asc, eq } from 'drizzle-orm';
import { client, db } from '@/lib/db/drizzle';
import {
  aeatControlFlujo,
  aeatLotes,
  empresas,
  enviosAeat,
  facturas,
  facturasDesglose,
  facturasLineas,
  teamMembers,
  teams,
  users,
  type Empresa,
  type RegistroVerifactu,
  type SerieFacturacion,
} from '@/lib/db/schema';
import type { ConfiguracionAeat } from '../aeat/config';
import { exportarRegistros, remitirPorRequerimiento, verificarConservacion } from '../aeat/no-verifactu';
import { serializarRegistroAlta } from '../aeat/registro-xml';
import {
  estadoRemision,
  procesarCola,
  reintentarRemision,
  remitirPendientesDeEmpresa,
  remitirTrasEmision,
  type DependenciasRemision,
} from '../aeat/remision';
import { SimuladorAeat, type Veredicto } from '../aeat/__tests__/simulador-aeat';
import { erroresXsd, xsdDisponible } from '../aeat/__tests__/validar-xsd';
import type { ContextoUsuario } from '../contexto';
import { fechaEnHuso, fechaHoraHuso, huellaRegistroAlta, TIPO_HUELLA_SHA256 } from '../crypto';
import { altaEmpresa } from '../empresas/servicio';
import { ErrorDominio, type CodigoError } from '../errores';
import { bloquearCadena, buscarRegistro, horaServidor, insertarRegistro, leerDesglose, marcarEmitida } from '../registros/repositorio';
import { anularFactura, emitirFactura, verificarCadenaEmpresa } from '../registros/servicio';

/* ------------------------------- utilidades -------------------------------- */

function dniAleatorio(): string {
  const numero = randomInt(10_000_000, 99_999_999);
  return `${numero}${'TRWAGMYFPDXBNJZSQVHLCKE'[numero % 23]}`;
}

async function crearCuenta(rol = 'owner'): Promise<ContextoUsuario> {
  const marca = `${Date.now()}-${randomInt(1e9)}`;
  const [usuario] = await db.insert(users).values({ email: `f4-${marca}@example.com`, passwordHash: 'x', role: 'owner' }).returning();
  const [cuenta] = await db.insert(teams).values({ name: `Cuenta ${marca}` }).returning();
  await db.insert(teamMembers).values({ userId: usuario.id, teamId: cuenta.id, role: rol });
  return { usuarioId: usuario.id, teamId: cuenta.id, rol, ip: '127.0.0.1' };
}

async function nuevaEmpresa(ctx: ContextoUsuario, nombre: string) {
  const { empresa, series } = await altaEmpresa(ctx, { nif: dniAleatorio(), nombreRazon: nombre });
  return { empresa, tickets: series.find((s) => s.tipoSerie === 'SIMPLIFICADA')! };
}

/** Borrador de ticket con una línea y su desglose (lo que hará el servicio de facturas). */
async function crearBorrador(empresa: Empresa, serie: SerieFacturacion, base = 100): Promise<string> {
  const cuota = (base * 0.21).toFixed(2);
  const total = (base * 1.21).toFixed(2);
  const [borrador] = await db
    .insert(facturas)
    .values({
      empresaId: empresa.id, serieId: serie.id, tipoFactura: 'F2', descripcionOperacion: 'Corte y peinado',
      baseImponibleTotal: base.toFixed(2), cuotaTotal: cuota, importeTotal: total, totalAPagar: total,
    })
    .returning();
  await db.insert(facturasLineas).values({
    empresaId: empresa.id, facturaId: borrador.id, orden: 1, descripcion: 'Servicio',
    precioUnitario: base.toFixed(2), baseLinea: base.toFixed(2), calificacionOperacion: 'S1', tipoImpositivo: '21.00', cuota,
  });
  await db.insert(facturasDesglose).values({
    empresaId: empresa.id, facturaId: borrador.id, calificacionOperacion: 'S1', tipoImpositivo: '21.00',
    baseImponible: base.toFixed(2), cuotaRepercutida: cuota,
  });
  return borrador.id;
}

/** Emite `n` tickets con el generador de XML real y devuelve sus registros. */
async function emitir(ctx: ContextoUsuario, empresa: Empresa, serie: SerieFacturacion, n = 1): Promise<RegistroVerifactu[]> {
  const registros: RegistroVerifactu[] = [];
  for (let i = 0; i < n; i++) {
    registros.push((await emitirFactura(ctx, empresa.id, await crearBorrador(empresa, serie, 10 + i))).registro);
  }
  return registros;
}

/** Reloj falso: empieza un poco por delante del real y solo avanza a mano. */
class Reloj {
  private t = Date.now() + 5_000;
  ahora = () => new Date(this.t);
  avanzar(segundos: number) {
    this.t += segundos * 1000;
  }
}

const colaDe = (empresaId: string) =>
  db.select().from(enviosAeat).where(eq(enviosAeat.empresaId, empresaId)).orderBy(asc(enviosAeat.numSecuencia));
const controlDe = async (empresaId: string) =>
  (await db.select().from(aeatControlFlujo).where(eq(aeatControlFlujo.empresaId, empresaId)))[0];
const lotesDe = (empresaId: string) =>
  db.select().from(aeatLotes).where(eq(aeatLotes.empresaId, empresaId)).orderBy(asc(aeatLotes.iniciadoEn), asc(aeatLotes.primerNumSecuencia));

async function rechazaCon(codigo: CodigoError, promesa: Promise<unknown>, contiene?: RegExp) {
  await assert.rejects(promesa, (error: unknown) => {
    assert.ok(error instanceof ErrorDominio, `se esperaba ErrorDominio y llegó: ${error}`);
    assert.equal(error.codigo, codigo, error.message);
    if (contiene) assert.match(error.message, contiene);
    return true;
  });
}

/* ------------------------------- preparación ------------------------------- */

let A: ContextoUsuario;
let B: ContextoUsuario;
let aeat: SimuladorAeat;
let config: ConfiguracionAeat;

/** Dependencias de la remisión apuntando al simulador, sin azar en las esperas. */
const deps = (reloj: Reloj, cambios: Partial<DependenciasRemision> = {}): DependenciasRemision => ({
  config,
  reloj: reloj.ahora,
  aleatorio: () => 0,
  ...cambios,
});

before(async () => {
  // Datos del productor: sin ellos el generador real se niega a escribir el registro.
  process.env.VERIFACTU_PRODUCTOR_NOMBRE = 'Productor de Pruebas, S.L.';
  process.env.VERIFACTU_PRODUCTOR_NIF = 'B12345674';

  aeat = await SimuladorAeat.iniciar();
  config = {
    entorno: 'pruebas',
    tipoCertificado: 'certificado',
    endpoints: { VOLUNTARIA: aeat.url('VerifactuSOAP'), REQUERIMIENTO: aeat.url('RequerimientoSOAP') },
    credenciales: null,
    timeoutMs: 2_000,
  };
  A = await crearCuenta();
  B = await crearCuenta();
});

after(async () => {
  // Todo lo que la aplicación ha enviado al simulador cumplía el XSD oficial.
  if (xsdDisponible) {
    for (const [i, peticion] of aeat.peticiones.entries()) {
      assert.equal(peticion.erroresXsd, null, `la petición ${i} no cumple SuministroLR.xsd`);
    }
  }
  await aeat.cerrar();
  await client.end();
});

/* ========================================================================== */
/*  1. Respuestas correctas                                                   */
/* ========================================================================== */

describe('Remisión en tiempo real con respuesta correcta', () => {
  it('remite el registro de alta recién emitido y guarda el acuse de recibo (CSV)', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Tiempo Real');
    const reloj = new Reloj();
    const [r1, r2] = await emitir(A, empresa, tickets, 2);

    // El XML guardado es el registro real y cumple el XSD por sí solo.
    if (xsdDisponible) assert.equal(erroresXsd(r1.xmlRegistro, 'SuministroInformacion.xsd'), null);
    assert.ok(r1.xmlRegistro.includes(`<sum1:Huella>${r1.huella}</sum1:Huella>`));
    assert.ok(r2.xmlRegistro.includes(`<sum1:Huella>${r1.huella}</sum1:Huella>`), 'el segundo registro referencia la huella del primero');

    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual(
      { estado: resultado.estado, enviados: resultado.enviados, aceptados: resultado.aceptados, pendientes: resultado.pendientes, error: resultado.error },
      { estado: 'ENVIADO', enviados: 2, aceptados: 2, pendientes: 0, error: null }
    );
    assert.match(resultado.csv!, /^A-SIMULADOR/);

    // Lo que recibió la AEAT: un mensaje, sin incidencia, con los registros en orden de generación.
    const [peticion] = aeat.de(empresa.nif);
    assert.equal(aeat.de(empresa.nif).length, 1);
    assert.equal(peticion.servicio, 'VerifactuSOAP');
    assert.equal(peticion.incidencia, false);
    assert.deepEqual(peticion.registros.map((r) => [r.operacion, r.refExterna]), [['Alta', r1.id], ['Alta', r2.id]]);
    // Cada registro viaja exactamente como se guardó al emitir.
    assert.ok(peticion.xml.includes(r1.xmlRegistro) && peticion.xml.includes(r2.xmlRegistro));

    // Estado de los envíos: ACEPTADO con el CSV del acuse.
    const cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.estado, e.intentos, e.csv, e.codigoError, e.entregaIncierta]), [
      ['ACEPTADO', 1, resultado.csv, null, false],
      ['ACEPTADO', 1, resultado.csv, null, false],
    ]);
    assert.ok(cola.every((e) => e.enviadoEn && e.respondidoEn && e.loteId === resultado.loteId));
    assert.deepEqual((cola[0].respuestaAeat as { estadoRegistro: string; conciliado: boolean }).estadoRegistro, 'Correcto');

    // El lote: evidencia del envío, con la respuesta íntegra de la AEAT.
    const [lote] = await lotesDe(empresa.id);
    assert.deepEqual(
      [lote.resultado, lote.tipoRemision, lote.numRegistros, lote.primerNumSecuencia, lote.ultimoNumSecuencia, lote.csv, lote.estadoHttp, lote.incidencia, lote.entorno],
      ['CORRECTO', 'VOLUNTARIA', 2, 1, 2, resultado.csv, 200, false, 'pruebas']
    );
    assert.ok(lote.respuestaXml!.includes(`<tikR:CSV>${resultado.csv}</tikR:CSV>`));
    assert.match(lote.peticionSha256, /^[0-9A-F]{64}$/);

    // Nada pendiente: no hay incidencia ni aviso para el usuario.
    const estado = await estadoRemision(A, empresa.id);
    assert.deepEqual([estado.pendientes, estado.incidencia, estado.aviso, estado.envios.ACEPTADO], [0, null, null, 2]);
    // Y sin registros en cola, una nueva llamada no envía nada.
    assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'SIN_PENDIENTES');
    assert.equal(aeat.de(empresa.nif).length, 1);
  });

  it('control de flujo: espera el «t» que indica la AEAT y agrupa lo acumulado mientras tanto', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Control de Flujo');
    const reloj = new Reloj();

    // La AEAT responde pidiendo 120 s de espera para el siguiente envío.
    aeat.encolar({ tipo: 'procesar', tiempoEspera: 120 });
    await emitir(A, empresa, tickets);
    const envio = reloj.ahora();
    assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'ENVIADO');
    const control = await controlDe(empresa.id);
    assert.equal(control.tiempoEsperaSeg, 120);
    assert.equal(control.proximoEnvioEn.getTime(), envio.getTime() + 120_000);

    // Tres tickets más en el siguiente minuto: se quedan en cola, no se envían.
    await emitir(A, empresa, tickets, 3);
    reloj.avanzar(119);
    const enEspera = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([enEspera.estado, enEspera.pendientes, enEspera.enviados], ['EN_ESPERA', 3, 0]);
    assert.equal(enEspera.proximoEnvioEn!.getTime(), envio.getTime() + 120_000);
    assert.equal(aeat.de(empresa.nif).length, 1);
    // Esperar el turno no es una incidencia.
    assert.equal((await estadoRemision(A, empresa.id)).aviso, null);

    // Cumplido el plazo, los tres salen juntos en un único mensaje.
    reloj.avanzar(1);
    const segundo = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([segundo.estado, segundo.enviados, segundo.aceptados], ['ENVIADO', 3, 3]);
    assert.deepEqual(aeat.de(empresa.nif).map((p) => p.registros.length), [1, 3]);
    assert.equal(aeat.de(empresa.nif)[1].incidencia, false);
    assert.equal((await controlDe(empresa.id)).tiempoEsperaSeg, 60, 'se adopta el nuevo «t» de la última respuesta');
  });

  it('una anulación genera su registro encadenado y se remite como RegistroAnulacion', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Anulación');
    const reloj = new Reloj();
    const borrador = await crearBorrador(empresa, tickets);
    const { registro: alta, factura } = await emitirFactura(A, empresa.id, borrador);
    await remitirTrasEmision(empresa.id, deps(reloj));

    const { registro: anulacion, factura: anulada } = await anularFactura(A, empresa.id, borrador);
    assert.equal(anulada.estado, 'ANULADA');
    assert.deepEqual(
      [anulacion.tipoRegistro, anulacion.numSecuencia, anulacion.huellaAnterior, anulacion.numSerieFactura],
      ['ANULACION', 2, alta.huella, factura.numSerieFactura]
    );
    if (xsdDisponible) assert.equal(erroresXsd(anulacion.xmlRegistro, 'SuministroInformacion.xsd'), null);
    assert.ok(!anulacion.xmlRegistro.includes('SinRegistroPrevio'), 'el alta consta en la AEAT');
    assert.equal((await verificarCadenaEmpresa(A, empresa.id)).integra, true);

    // No se anula dos veces, ni un borrador, ni desde otra cuenta.
    await rechazaCon('CONFLICTO', anularFactura(A, empresa.id, borrador), /ya está anulada/);
    await rechazaCon('CONFLICTO', anularFactura(A, empresa.id, await crearBorrador(empresa, tickets)), /borrador/);
    await rechazaCon('NO_ENCONTRADO', anularFactura(B, empresa.id, borrador));

    reloj.avanzar(60);
    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([resultado.estado, resultado.aceptados], ['ENVIADO', 1]);
    assert.deepEqual(aeat.de(empresa.nif)[1].registros.map((r) => [r.operacion, r.numSerie, r.refExterna]), [
      ['Anulacion', factura.numSerieFactura, anulacion.id],
    ]);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => e.estado), ['ACEPTADO', 'ACEPTADO']);
  });
});

/* ========================================================================== */
/*  2. Errores de validación de la AEAT                                       */
/* ========================================================================== */

describe('Errores de validación de la AEAT', () => {
  it('respuesta parcial: cada registro queda en SU estado, con su código de error', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Fontanería Parcial');
    const reloj = new Reloj();
    const [r1, r2, r3] = await emitir(A, empresa, tickets, 3);

    const veredictos: Record<string, Veredicto> = {
      [r2.numSerieFactura]: { estado: 'AceptadoConErrores', codigo: '2000', descripcion: 'El cálculo de la huella suministrada es incorrecta.' },
      [r3.numSerieFactura]: { estado: 'Incorrecto', codigo: '1100', descripcion: 'Valor o tipo incorrecto del campo: <DescripcionOperacion>' },
    };
    aeat.encolar({ tipo: 'procesar', veredicto: (r) => veredictos[r.numSerie] ?? { estado: 'Correcto' } });

    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual(
      [resultado.estado, resultado.aceptados, resultado.aceptadosConErrores, resultado.rechazados, resultado.devueltosACola, resultado.pendientes],
      ['ENVIADO', 1, 1, 1, 0, 0]
    );

    const cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.registroId, e.estado, e.csv, e.codigoError, e.descripcionError]), [
      [r1.id, 'ACEPTADO', resultado.csv, null, null],
      [r2.id, 'ACEPTADO_CON_ERRORES', resultado.csv, '2000', 'El cálculo de la huella suministrada es incorrecta.'],
      // Rechazado: no consta en la AEAT, así que no tiene CSV.
      [r3.id, 'RECHAZADO', null, '1100', 'Valor o tipo incorrecto del campo: <DescripcionOperacion>'],
    ]);
    const [lote] = await lotesDe(empresa.id);
    assert.deepEqual([lote.resultado, lote.csv], ['PARCIALMENTE_CORRECTO', resultado.csv]);

    // Un rechazo es definitivo: no se reintenta ni bloquea a los siguientes registros.
    const [r4] = await emitir(A, empresa, tickets);
    reloj.avanzar(60);
    assert.deepEqual((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).aceptados, 1);
    assert.deepEqual(aeat.de(empresa.nif)[1].registros.map((r) => r.refExterna), [r4.id]);

    // Los estados finales no se reescriben: la corrección es siempre un registro NUEVO.
    for (const [registroId, estado] of [[r1.id, 'RECHAZADO'], [r3.id, 'ACEPTADO'], [r2.id, 'ERROR_TRANSITORIO']] as const) {
      await assert.rejects(db.update(enviosAeat).set({ estado }).where(eq(enviosAeat.registroId, registroId)), /estado final/);
    }
    // El registro rechazado sigue en la cadena, íntegro: rechazado por la AEAT no es borrado.
    assert.equal((await verificarCadenaEmpresa(A, empresa.id)).registrosVerificados, 4);
  });

  it('todos rechazados: envío «Incorrecto» sin CSV; anular esa factura declara «SinRegistroPrevio»', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Albañil Rechazado');
    const reloj = new Reloj();
    const borrador = await crearBorrador(empresa, tickets);
    await emitirFactura(A, empresa.id, borrador);

    aeat.encolar({ tipo: 'procesar', veredicto: () => ({ estado: 'Incorrecto', codigo: '1104', descripcion: 'Valor del campo NumSerieFactura incorrecto' }) });
    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([resultado.estado, resultado.rechazados, resultado.csv], ['ENVIADO', 1, null]);
    const [lote] = await lotesDe(empresa.id);
    assert.deepEqual([lote.resultado, lote.csv], ['INCORRECTO', null]);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.estado, e.codigoError]), [['RECHAZADO', '1104']]);
    // La AEAT respondió: aunque rechazara el registro, no hay incidencia técnica.
    assert.equal((await estadoRemision(A, empresa.id)).incidencia, null);

    // Para la AEAT esa factura no existe: su anulación lo dice.
    const { registro: anulacion } = await anularFactura(A, empresa.id, borrador);
    assert.ok(anulacion.xmlRegistro.includes('<sum1:SinRegistroPrevio>S</sum1:SinRegistroPrevio>'));
    reloj.avanzar(60);
    await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.equal(aeat.de(empresa.nif)[1].registros[0].sinRegistroPrevio, true);
  });

  it('duplicado en el PRIMER intento: es un rechazo real (esa factura ya constaba en la AEAT)', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Taller Duplicado');
    const reloj = new Reloj();
    const [registro] = await emitir(A, empresa, tickets);
    // Otro programa del mismo obligado ya remitió una factura con ESE número.
    aeat.yaConsta(empresa.nif, registro.numSerieFactura);

    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([resultado.estado, resultado.rechazados, resultado.aceptados, resultado.csv], ['ENVIADO', 1, 0, null]);

    // No hubo ningún intento previo sin respuesta: el duplicado NO se toma por una confirmación.
    const [envio] = await colaDe(empresa.id);
    assert.deepEqual([envio.estado, envio.codigoError, envio.descripcionError, envio.csv], ['RECHAZADO', '3000', 'Registro de facturación duplicado.', null]);
    const detalle = envio.respuestaAeat as { conciliado: boolean; registroDuplicado: { estado: string } };
    assert.deepEqual([detalle.conciliado, detalle.registroDuplicado.estado], [false, 'Correcta']);
  });

  it('SOAP Fault de cliente: la AEAT rechaza el mensaje ENTERO y nada se da por rechazado', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Fault');
    const reloj = new Reloj();
    const [r1, r2, r3] = await emitir(A, empresa, tickets, 3);

    aeat.encolar({ tipo: 'fault', servidor: false, codigo: '4104', mensaje: 'Error en la cabecera: el valor del campo NIF del bloque ObligadoEmision no está identificado.' });
    const rechazo = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual(
      [rechazo.estado, rechazo.enviados, rechazo.rechazados, rechazo.devueltosACola, rechazo.pendientes, rechazo.error?.codigo],
      ['ENVIO_RECHAZADO', 3, 0, 3, 3, '4104']
    );

    // Ningún registro se marca RECHAZADO (sería irreversible, y la causa es de configuración).
    let cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.estado, e.intentos, e.codigoError, e.entregaIncierta]), Array(3).fill(['ERROR_TRANSITORIO', 1, '4104', false]));
    assert.match(cola[0].descripcionError!, /^4104: Error en la cabecera/);
    const [lote] = await lotesDe(empresa.id);
    assert.deepEqual([lote.resultado, lote.codigoError, lote.estadoHttp], ['RECHAZADO', '4104', 500]);
    assert.match(lote.respuestaXml!, /Codigo\[4104\]/);

    // La empresa queda señalada y el aviso al usuario lo dice.
    let control = await controlDe(empresa.id);
    assert.deepEqual([control.requiereIntervencion, control.fallosConsecutivos, control.ultimoErrorCodigo], [true, 1, '4104']);
    const estado = await estadoRemision(A, empresa.id);
    assert.equal(estado.incidencia?.requiereIntervencion, true);
    assert.match(estado.aviso!, /Faltan 3 registros.*rechazando los envíos/);

    // Se sigue reintentando (la obligación de remitir no desaparece), pero de UNO EN UNO,
    // para aislar el registro problemático: aquí el segundo es el que la AEAT no admite.
    reloj.avanzar(60);
    const uno = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([uno.estado, uno.enviados, uno.aceptados], ['ENVIADO', 1, 1]);
    assert.deepEqual(aeat.de(empresa.nif).at(-1)!.registros.map((r) => r.refExterna), [r1.id]);
    assert.equal(aeat.de(empresa.nif).at(-1)!.incidencia, true);
    control = await controlDe(empresa.id);
    assert.deepEqual([control.requiereIntervencion, control.fallosConsecutivos], [false, 0], 'la AEAT vuelve a aceptar: se levanta la señal');

    reloj.avanzar(60);
    aeat.encolar({ tipo: 'fault', servidor: false, codigo: '4102', mensaje: 'El XML no cumple el esquema. Falta informar campo obligatorio.' });
    const mal = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([mal.estado, mal.enviados], ['ENVIO_RECHAZADO', 2]);
    reloj.avanzar(60);
    aeat.encolar({ tipo: 'fault', servidor: false, codigo: '4102', mensaje: 'El XML no cumple el esquema. Falta informar campo obligatorio.' });
    const aislado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([aislado.estado, aislado.enviados], ['ENVIO_RECHAZADO', 1]);
    assert.deepEqual(aeat.de(empresa.nif).at(-1)!.registros.map((r) => r.refExterna), [r2.id]);

    // El orden se respeta: el tercero NO adelanta al segundo mientras este siga sin resolver.
    cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.registroId, e.estado]), [[r1.id, 'ACEPTADO'], [r2.id, 'ERROR_TRANSITORIO'], [r3.id, 'ERROR_TRANSITORIO']]);
    assert.equal((await controlDe(empresa.id)).fallosConsecutivos, 2);
  });
});

/* ========================================================================== */
/*  3. Reintentos automáticos                                                 */
/* ========================================================================== */

describe('Reintentos automáticos de la cola', () => {
  it('caída temporal de la AEAT (503): espera exponencial, incidencia y recuperación', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Caída');
    const reloj = new Reloj();
    const [r1] = await emitir(A, empresa, tickets);
    const inicio = reloj.ahora();

    // --- Primer fallo ---
    aeat.encolar({ tipo: 'http', estado: 503 });
    const f1 = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([f1.estado, f1.devueltosACola, f1.pendientes, f1.error?.codigo], ['FALLO_TRANSITORIO', 1, 1, 'HTTP_503']);
    assert.equal(f1.proximoEnvioEn!.getTime(), inicio.getTime() + 60_000, 'primer reintento: 60 s');

    let [envio] = await colaDe(empresa.id);
    assert.deepEqual([envio.estado, envio.intentos, envio.codigoError, envio.csv], ['ERROR_TRANSITORIO', 1, 'HTTP_503', null]);
    assert.equal(envio.proximoIntentoEn.getTime(), inicio.getTime() + 60_000);
    let control = await controlDe(empresa.id);
    assert.deepEqual([control.fallosConsecutivos, control.incidenciaDesde?.getTime(), control.requiereIntervencion], [1, inicio.getTime(), false]);
    assert.deepEqual((await lotesDe(empresa.id)).map((l) => [l.resultado, l.estadoHttp, l.codigoError]), [['ERROR_TRANSITORIO', 503, 'HTTP_503']]);

    // El usuario ve el aviso con cuántos registros faltan (art. 16.4) y puede seguir facturando.
    const [r2] = await emitir(A, empresa, tickets);
    const estado = await estadoRemision(A, empresa.id);
    assert.equal(estado.pendientes, 2);
    assert.equal(estado.incidencia?.codigo, 'HTTP_503');
    assert.match(estado.aviso!, /Faltan 2 registros de facturación por remitir.*Se reintenta automáticamente/);

    // Antes de tiempo no se reintenta, ni pidiéndolo a mano.
    reloj.avanzar(59);
    assert.equal((await reintentarRemision(A, empresa.id, deps(reloj))).estado, 'EN_ESPERA');
    assert.equal(aeat.de(empresa.nif).length, 1);

    // --- Segundo fallo: la espera se duplica ---
    reloj.avanzar(1);
    aeat.encolar({ tipo: 'http', estado: 503 });
    const f2 = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.equal(f2.estado, 'FALLO_TRANSITORIO');
    assert.equal(f2.proximoEnvioEn!.getTime(), reloj.ahora().getTime() + 120_000, 'segundo reintento: 120 s');
    assert.equal((await controlDe(empresa.id)).fallosConsecutivos, 2);
    // El mensaje reintentado ya declara la incidencia y lleva también el registro nuevo, detrás.
    const reintento = aeat.de(empresa.nif)[1];
    assert.equal(reintento.incidencia, true);
    assert.deepEqual(reintento.registros.map((r) => r.refExterna), [r1.id, r2.id]);

    reloj.avanzar(119);
    assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'EN_ESPERA');

    // --- La AEAT vuelve: se remite todo, en orden y con «Incidencia» = S ---
    reloj.avanzar(1);
    const ok = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([ok.estado, ok.enviados, ok.aceptados, ok.pendientes], ['ENVIADO', 2, 2, 0]);
    assert.equal(aeat.de(empresa.nif)[2].incidencia, true);

    const cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.estado, e.intentos, e.csv, e.codigoError]), [
      ['ACEPTADO', 3, ok.csv, null],
      ['ACEPTADO', 2, ok.csv, null],
    ]);
    // Incidencia cerrada: contador a cero, sin aviso, y el siguiente mensaje ya no la declara.
    control = await controlDe(empresa.id);
    assert.deepEqual([control.fallosConsecutivos, control.incidenciaDesde, control.ultimoErrorCodigo], [0, null, null]);
    assert.equal((await estadoRemision(A, empresa.id)).aviso, null);
    assert.deepEqual((await lotesDe(empresa.id)).map((l) => [l.resultado, l.incidencia, l.numRegistros]), [
      ['ERROR_TRANSITORIO', false, 1],
      ['ERROR_TRANSITORIO', true, 2],
      ['CORRECTO', true, 2],
    ]);
    await emitir(A, empresa, tickets);
    reloj.avanzar(60);
    await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.equal(aeat.de(empresa.nif)[3].incidencia, false);
  });

  it('caída prolongada: la espera crece hasta una hora y ahí se queda (reintento al menos horario)', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Caída Larga');
    const reloj = new Reloj();
    await emitir(A, empresa, tickets);

    const esperas: number[] = [];
    for (let i = 0; i < 9; i++) {
      aeat.encolar({ tipo: 'fault', servidor: true, mensaje: 'Internal error' });
      const r = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
      assert.equal(r.estado, 'FALLO_TRANSITORIO');
      const espera = (r.proximoEnvioEn!.getTime() - reloj.ahora().getTime()) / 1000;
      esperas.push(espera);
      reloj.avanzar(espera);
    }
    assert.deepEqual(esperas, [60, 120, 240, 480, 960, 1920, 3600, 3600, 3600]);
    assert.equal(aeat.de(empresa.nif).length, 9, 'un intento por cada espera cumplida');

    // Un Fault «Server» no es un rechazo: nada requiere intervención y el registro sigue en cola.
    const control = await controlDe(empresa.id);
    assert.deepEqual([control.fallosConsecutivos, control.requiereIntervencion, control.ultimoErrorCodigo], [9, false, 'FAULT_SERVER']);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.estado, e.intentos]), [['ERROR_TRANSITORIO', 9]]);

    // En cuanto la AEAT responde, se entrega y el contador vuelve a cero.
    const ok = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([ok.estado, ok.aceptados], ['ENVIADO', 1]);
    assert.equal((await controlDe(empresa.id)).fallosConsecutivos, 0);
  });

  it('sin cobertura: el registro se queda en cola y sale, con incidencia, al recuperar la conexión', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Fontanero Sin Cobertura');
    const reloj = new Reloj();
    const [registro] = await emitir(A, empresa, tickets);

    // Un puerto en el que no escucha nadie: conexión rechazada, como sin red.
    const puertoCerrado = await new Promise<number>((listo) => {
      const s = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = s.address() as net.AddressInfo;
        s.close(() => listo(port));
      });
    });
    const sinRed: ConfiguracionAeat = { ...config, endpoints: { ...config.endpoints, VOLUNTARIA: `http://127.0.0.1:${puertoCerrado}/VerifactuSOAP` } };

    // La emisión no falla aunque no haya conexión: `remitirTrasEmision` nunca lanza.
    await remitirTrasEmision(empresa.id, deps(reloj, { config: sinRed }));
    let [envio] = await colaDe(empresa.id);
    assert.deepEqual([envio.estado, envio.intentos, envio.codigoError, envio.entregaIncierta], ['ERROR_TRANSITORIO', 1, 'ECONNREFUS', false]);
    assert.match(envio.descripcionError!, /^ECONNREFUSED: No se ha podido contactar con la AEAT/);
    assert.equal(aeat.de(empresa.nif).length, 0, 'el mensaje no llegó a salir');

    // Vuelve la cobertura: el worker lo remite pasado el minuto.
    reloj.avanzar(60);
    const ok = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([ok.estado, ok.aceptados], ['ENVIADO', 1]);
    assert.equal(aeat.de(empresa.nif)[0].incidencia, true);
    [envio] = await colaDe(empresa.id);
    assert.deepEqual([envio.registroId, envio.estado, envio.intentos], [registro.id, 'ACEPTADO', 2]);
  });

  it('timeout con el registro YA en la AEAT: el reenvío se concilia por «duplicado», sin perder ni duplicar', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Timeout');
    const reloj = new Reloj();
    const [r1, r2] = await emitir(A, empresa, tickets, 2);
    const impaciente: ConfiguracionAeat = { ...config, timeoutMs: 300 };

    // La AEAT registra los dos, pero su respuesta no llega.
    aeat.encolar({ tipo: 'registrar-sin-responder' });
    const timeout = await remitirPendientesDeEmpresa(empresa.id, deps(reloj, { config: impaciente }));
    assert.deepEqual([timeout.estado, timeout.error?.codigo, timeout.devueltosACola], ['FALLO_TRANSITORIO', 'TIMEOUT', 2]);
    let cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.estado, e.entregaIncierta, e.csv]), Array(2).fill(['ERROR_TRANSITORIO', true, null]));

    // Mientras tanto se emite un tercero, que la AEAT no ha visto nunca.
    const [r3] = await emitir(A, empresa, tickets);

    // Reintento: la AEAT rechaza r1 y r2 por duplicados (ya constan como «Correcta») y acepta r3.
    reloj.avanzar(60);
    const reenvio = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([reenvio.estado, reenvio.aceptados, reenvio.rechazados, reenvio.pendientes], ['ENVIADO', 3, 0, 0]);

    cola = await colaDe(empresa.id);
    assert.deepEqual(cola.map((e) => [e.registroId, e.estado, e.intentos, e.entregaIncierta]), [
      [r1.id, 'ACEPTADO', 2, false],
      [r2.id, 'ACEPTADO', 2, false],
      [r3.id, 'ACEPTADO', 1, false],
    ]);
    // Los conciliados no tienen CSV (era el del envío cuya respuesta se perdió) y queda anotado por qué.
    type Detalle = { conciliado: boolean; registroDuplicado: { estado: string } | null; codigoError: string | null };
    const detalle = cola.map((e) => e.respuestaAeat as Detalle);
    assert.deepEqual(detalle.map((d) => [d.conciliado, d.registroDuplicado?.estado ?? null, d.codigoError]), [
      [true, 'Correcta', '3000'],
      [true, 'Correcta', '3000'],
      [false, null, null],
    ]);
    assert.deepEqual(cola.map((e) => e.csv), [null, null, reenvio.csv]);
    assert.deepEqual((await lotesDe(empresa.id)).map((l) => [l.resultado, l.codigoError]), [['ERROR_TRANSITORIO', 'TIMEOUT'], ['PARCIALMENTE_CORRECTO', null]]);
  });

  it('proceso interrumpido a mitad de envío: el arrendamiento caduca y otro worker lo recupera', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Caída del Servidor');
    const reloj = new Reloj();
    const [registro] = await emitir(A, empresa, tickets);

    // El proceso «muere» después de enviar y antes de anotar la respuesta.
    let lecturas = 0;
    const relojQueSeCae = () => {
      if (++lecturas === 2) throw new Error('proceso interrumpido');
      return reloj.ahora();
    };
    await assert.rejects(remitirPendientesDeEmpresa(empresa.id, deps(reloj, { reloj: relojQueSeCae })), /proceso interrumpido/);
    assert.equal(aeat.de(empresa.nif).length, 1, 'la AEAT sí recibió y registró el mensaje');
    assert.deepEqual((await colaDe(empresa.id)).map((e) => e.estado), ['ENVIANDO']);
    assert.deepEqual((await lotesDe(empresa.id)).map((l) => l.resultado), ['EN_CURSO']);

    // Mientras el arrendamiento siga vigente nadie más toca esos registros.
    reloj.avanzar(30);
    assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'OCUPADA');
    assert.equal((await estadoRemision(A, empresa.id)).pendientes, 1, 'un registro en vuelo sigue contando como no remitido');

    // Caducado (timeout de red + 60 s de margen), el siguiente worker los devuelve a la cola.
    reloj.avanzar(33);
    const recuperacion = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.equal(recuperacion.estado, 'EN_ESPERA');
    const [envio] = await colaDe(empresa.id);
    assert.deepEqual([envio.estado, envio.entregaIncierta, envio.codigoError], ['ERROR_TRANSITORIO', true, 'INTERRUMP']);
    assert.deepEqual((await lotesDe(empresa.id)).map((l) => [l.resultado, l.codigoError]), [['ERROR_TRANSITORIO', 'INTERRUMPIDO']]);
    const control = await controlDe(empresa.id);
    assert.deepEqual([control.loteEnCursoId, control.fallosConsecutivos, control.incidenciaDesde !== null], [null, 1, true]);

    // Y al reenviar, la AEAT confirma que ya lo tenía: aceptado, sin duplicar.
    reloj.avanzar(60);
    const reenvio = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([reenvio.estado, reenvio.aceptados, reenvio.rechazados], ['ENVIADO', 1, 0]);
    const [final] = await colaDe(empresa.id);
    assert.deepEqual([final.registroId, final.estado, (final.respuestaAeat as { conciliado: boolean }).conciliado], [registro.id, 'ACEPTADO', true]);
  });

  it('dos workers a la vez sobre la misma empresa: sale un único mensaje', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Concurrencia');
    const reloj = new Reloj();
    await emitir(A, empresa, tickets, 3);

    aeat.encolar({ tipo: 'procesar', retrasoMs: 200 });
    const resultados = await Promise.all([
      remitirPendientesDeEmpresa(empresa.id, deps(reloj)),
      remitirPendientesDeEmpresa(empresa.id, deps(reloj)),
      remitirPendientesDeEmpresa(empresa.id, deps(reloj)),
    ]);
    assert.deepEqual(resultados.map((r) => r.estado).sort(), ['ENVIADO', 'OCUPADA', 'OCUPADA']);
    assert.equal(aeat.de(empresa.nif).length, 1);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.estado, e.intentos]), Array(3).fill(['ACEPTADO', 1]));
  });

  it('respuesta sin «RefExterna» o incompleta: se casa por factura y lo que falta vuelve a la cola', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Respuesta Rara');
    const reloj = new Reloj();
    const [r1, r2] = await emitir(A, empresa, tickets, 2);

    // La AEAT no devuelve RefExterna y, además, rechaza solo el segundo.
    aeat.encolar({
      tipo: 'procesar',
      sinRefExterna: true,
      veredicto: (r) => (r.numSerie === r2.numSerieFactura ? { estado: 'Incorrecto', codigo: '1100', descripcion: 'Campo incorrecto' } : { estado: 'Correcto' }),
    });
    await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.registroId, e.estado]), [[r1.id, 'ACEPTADO'], [r2.id, 'RECHAZADO']]);

    // Un 200 con un cuerpo que no es SOAP no se interpreta como aceptación.
    await emitir(A, empresa, tickets);
    reloj.avanzar(60);
    aeat.encolar({ tipo: 'http', estado: 200 });
    const ilegible = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([ilegible.estado, ilegible.error?.codigo], ['FALLO_TRANSITORIO', 'RESPUESTA_ILEGIBLE']);
    assert.deepEqual((await colaDe(empresa.id)).at(-1)!.estado, 'ERROR_TRANSITORIO');
  });

  it('más de 1.000 registros acumulados: mensajes de 1.000 como máximo, y un mensaje lleno no espera', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Supermercado Mil Tickets');
    const reloj = new Reloj();

    // Un primer envío deja a la empresa dentro de su minuto de espera.
    await emitir(A, empresa, tickets);
    await remitirPendientesDeEmpresa(empresa.id, deps(reloj));

    // En ese minuto se acumulan 1.001 tickets.
    const TOTAL = 1001;
    const borradores = await db
      .insert(facturas)
      .values(
        Array.from({ length: TOTAL }, () => ({
          empresaId: empresa.id, serieId: tickets.id, tipoFactura: 'F2' as const, descripcionOperacion: 'Venta',
          baseImponibleTotal: '10.00', cuotaTotal: '2.10', importeTotal: '12.10', totalAPagar: '12.10',
        }))
      )
      .returning({ id: facturas.id });
    await db.insert(facturasLineas).values(
      borradores.map((b) => ({
        empresaId: empresa.id, facturaId: b.id, orden: 1, descripcion: 'Venta', precioUnitario: '10.00', baseLinea: '10.00',
        calificacionOperacion: 'S1' as const, tipoImpositivo: '21.00', cuota: '2.10',
      }))
    );
    await db.insert(facturasDesglose).values(
      borradores.map((b) => ({
        empresaId: empresa.id, facturaId: b.id, calificacionOperacion: 'S1' as const, tipoImpositivo: '21.00',
        baseImponible: '10.00', cuotaRepercutida: '2.10',
      }))
    );
    const ids: string[] = [];
    for (const b of borradores) ids.push((await emitirFactura(A, empresa.id, b.id)).registro.id);

    // Sin avanzar el reloj: hay un mensaje lleno, así que sale ya (art. 16.2.c), con 1.000 justos.
    const lleno = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([lleno.estado, lleno.enviados, lleno.aceptados, lleno.pendientes], ['ENVIADO', 1000, 1000, 1]);
    const mensaje = aeat.de(empresa.nif)[1];
    assert.equal(mensaje.registros.length, 1000);
    assert.deepEqual(mensaje.registros.map((r) => r.refExterna), ids.slice(0, 1000), 'los 1.000 más antiguos, en orden');
    assert.equal(mensaje.incidencia, false);

    // El que queda ya no llena un mensaje: espera su turno.
    assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'EN_ESPERA');
    reloj.avanzar(60);
    const resto = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([resto.estado, resto.enviados, resto.pendientes], ['ENVIADO', 1, 0]);
    assert.deepEqual(aeat.de(empresa.nif)[2].registros.map((r) => r.refExterna), [ids[1000]]);

    assert.deepEqual((await lotesDe(empresa.id)).map((l) => [l.numRegistros, l.primerNumSecuencia, l.ultimoNumSecuencia, l.resultado]), [
      [1, 1, 1, 'CORRECTO'],
      [1000, 2, 1001, 'CORRECTO'],
      [1, 1002, 1002, 'CORRECTO'],
    ]);
    const estados = await estadoRemision(A, empresa.id);
    assert.deepEqual([estados.envios.ACEPTADO, estados.pendientes], [1002, 0]);
    assert.equal((await verificarCadenaEmpresa(A, empresa.id)).registrosVerificados, 1002);
  });

  it('el worker recorre la cola: remite a quien le toca y deja esperar a quien está en reintento', async () => {
    // Simulador propio: en la base de datos de pruebas hay empresas de otros tests con registros en cola.
    const aeatWorker = await SimuladorAeat.iniciar();
    const configWorker: ConfiguracionAeat = {
      ...config,
      endpoints: { VOLUNTARIA: aeatWorker.url('VerifactuSOAP'), REQUERIMIENTO: aeatWorker.url('RequerimientoSOAP') },
    };
    try {
      const reloj = new Reloj();
      reloj.avanzar(24 * 3600); // por delante de cualquier espera dejada por otros tests
      const x = await nuevaEmpresa(A, 'Worker X');
      const y = await nuevaEmpresa(B, 'Worker Y');
      const z = await nuevaEmpresa(A, 'Worker Z');
      await emitir(A, x.empresa, x.tickets);
      await emitir(B, y.empresa, y.tickets, 2);
      await emitir(A, z.empresa, z.tickets);

      // Z acaba de fallar: está en espera de reintento (60 s).
      aeatWorker.encolar({ tipo: 'http', estado: 503 });
      await remitirPendientesDeEmpresa(z.empresa.id, deps(reloj, { config: configWorker }));

      const opciones = { maxEmpresas: 100_000, concurrencia: 8 };
      const pasada1 = await procesarCola(deps(reloj, { config: configWorker }), opciones);
      assert.ok(pasada1.empresasProcesadas >= 2 && (pasada1.porEstado.ENVIADO ?? 0) >= 2);
      assert.deepEqual((await colaDe(x.empresa.id)).map((e) => e.estado), ['ACEPTADO']);
      assert.deepEqual((await colaDe(y.empresa.id)).map((e) => e.estado), ['ACEPTADO', 'ACEPTADO']);
      assert.deepEqual((await colaDe(z.empresa.id)).map((e) => [e.estado, e.intentos]), [['ERROR_TRANSITORIO', 1]]);
      assert.deepEqual([aeatWorker.de(x.empresa.nif).length, aeatWorker.de(y.empresa.nif).length, aeatWorker.de(z.empresa.nif).length], [1, 1, 1]);

      // Una pasada inmediata no repite nada de X, Y ni Z.
      await procesarCola(deps(reloj, { config: configWorker }), opciones);
      assert.deepEqual([aeatWorker.de(x.empresa.nif).length, aeatWorker.de(z.empresa.nif).length], [1, 1]);

      // Pasado el minuto, la siguiente pasada recoge a Z.
      reloj.avanzar(60);
      await procesarCola(deps(reloj, { config: configWorker }), opciones);
      assert.deepEqual((await colaDe(z.empresa.id)).map((e) => [e.estado, e.intentos]), [['ACEPTADO', 2]]);
      assert.equal(aeatWorker.de(z.empresa.nif)[1].incidencia, true);
    } finally {
      await aeatWorker.cerrar();
    }
  });
});

/* ========================================================================== */
/*  4. Modo NO VERI*FACTU                                                     */
/* ========================================================================== */

/** Firma XAdES de pega: estructura válida para el XSD, sin valor criptográfico. */
const FIRMA_SIMULADA =
  '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:SignedInfo>' +
  '<ds:CanonicalizationMethod Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"/>' +
  '<ds:SignatureMethod Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"/>' +
  '<ds:Reference URI=""><ds:DigestMethod Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"/><ds:DigestValue>AAAA</ds:DigestValue></ds:Reference>' +
  '</ds:SignedInfo><ds:SignatureValue>AAAA</ds:SignatureValue></ds:Signature>';

/**
 * La emisión en modo NO VERI*FACTU aún no existe en la aplicación (falta el
 * módulo de firma). Para probar los CONTROLES de remisión de este modo, el
 * test genera el registro por debajo del servicio, con una firma simulada.
 */
async function emitirNoVerifactuSimulado(ctx: ContextoUsuario, empresa: Empresa, borradorId: string): Promise<RegistroVerifactu> {
  return db.transaction(async (tx) => {
    const cabecera = (await bloquearCadena(tx, empresa.id, 'FACTURACION'))!;
    const anterior = cabecera.ultimoId ? ((await buscarRegistro(tx, empresa.id, cabecera.ultimoId)) ?? null) : null;
    const ahora = await horaServidor(tx);
    const factura = await marcarEmitida(tx, empresa.id, borradorId, {
      emisorNif: empresa.nif, emisorNombreRazon: empresa.nombreRazon, emisorDomicilio: null,
      fechaExpedicion: fechaEnHuso(ahora, empresa.husoHorario),
    });
    const fechaHoraHusoGen = fechaHoraHuso(ahora, empresa.husoHorario);
    const huella = huellaRegistroAlta({
      idEmisorFactura: empresa.nif, numSerieFactura: factura.numSerieFactura!, fechaExpedicion: factura.fechaExpedicion!,
      tipoFactura: factura.tipoFactura, cuotaTotal: factura.cuotaTotal, importeTotal: factura.importeTotal,
      huellaAnterior: cabecera.ultimaHuella, fechaHoraHusoGen,
    });
    const registroId = randomUUID();
    const sif = { idSistema: 'VF', nombre: 'Verifactu SaaS', version: '0.3.0' } as const;
    const xml = serializarRegistroAlta({
      registroId, empresa: { ...empresa, modoVerifactu: 'NO_VERIFACTU' }, factura,
      desglose: await leerDesglose(tx, empresa.id, factura.id), relacionadas: [], esSubsanacion: false, rechazoPrevio: 'N',
      encadenamiento: anterior
        ? { esPrimerRegistro: false, registroAnterior: { idEmisorFactura: anterior.idEmisorFactura, numSerieFactura: anterior.numSerieFactura, fechaExpedicion: anterior.fechaExpedicion, huella: anterior.huella } }
        : { esPrimerRegistro: true, registroAnterior: null },
      sistemaInformatico: {
        ...sif, numeroInstalacion: empresa.numeroInstalacion, productor: { nombreRazon: 'Productor de Pruebas, S.L.', nif: 'B12345674' },
        soloVerifactu: false, multiObligado: true, multiplesObligadosAhora: true,
      },
      fechaHoraHusoGen, tipoHuella: TIPO_HUELLA_SHA256, huella, qrUrl: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu',
    }).replace('</sum1:RegistroAlta>', `${FIRMA_SIMULADA}</sum1:RegistroAlta>`);

    return insertarRegistro(tx, {
      id: registroId, empresaId: empresa.id, facturaId: factura.id, tipoRegistro: 'ALTA',
      idEmisorFactura: empresa.nif, nombreRazonEmisor: empresa.nombreRazon, numSerieFactura: factura.numSerieFactura!,
      fechaExpedicion: factura.fechaExpedicion!, tipoFactura: factura.tipoFactura, cuotaTotal: factura.cuotaTotal, importeTotal: factura.importeTotal,
      fechaHoraHusoGen, esPrimerRegistro: anterior === null, registroAnteriorId: cabecera.ultimoId, huellaAnterior: cabecera.ultimaHuella,
      tipoHuella: TIPO_HUELLA_SHA256, huella, modo: 'NO_VERIFACTU', sifIdSistema: sif.idSistema, sifVersion: sif.version,
      sifNumeroInstalacion: empresa.numeroInstalacion, xmlRegistro: xml, xmlFirmado: true,
      qrUrl: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu', creadoPor: ctx.usuarioId,
    });
  });
}

describe('Modo NO VERI*FACTU: conservación local sin remisión automática', () => {
  it('sus registros nacen fuera de la cola y nunca se remiten; los VERI*FACTU pendientes de antes, sí', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Cambio de Modo');
    const reloj = new Reloj();

    // Un registro generado como VERI*FACTU que aún no se ha remitido…
    const [pendiente] = await emitir(A, empresa, tickets);
    // …y la empresa pasa a NO VERI*FACTU, donde genera dos registros más.
    await db.update(empresas).set({ modoVerifactu: 'NO_VERIFACTU' }).where(eq(empresas.id, empresa.id));
    const local1 = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));
    const local2 = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));

    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.registroId, e.estado]), [
      [pendiente.id, 'PENDIENTE'],
      [local1.id, 'NO_APLICA'],
      [local2.id, 'NO_APLICA'],
    ]);

    // La remisión decide por el modo de cada REGISTRO: sale solo el que se generó como VERI*FACTU.
    const resultado = await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    assert.deepEqual([resultado.estado, resultado.enviados, resultado.pendientes], ['ENVIADO', 1, 0]);
    assert.deepEqual(aeat.de(empresa.nif).map((p) => p.registros.map((r) => r.refExterna)), [[pendiente.id]]);

    // Por muchas pasadas del worker que haya, los conservados no salen jamás.
    for (let i = 0; i < 3; i++) {
      reloj.avanzar(3600);
      assert.equal((await remitirPendientesDeEmpresa(empresa.id, deps(reloj))).estado, 'SIN_PENDIENTES');
    }
    assert.equal(aeat.de(empresa.nif).length, 1);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => [e.estado, e.intentos]), [['ACEPTADO', 1], ['NO_APLICA', 0], ['NO_APLICA', 0]]);

    // Para el usuario: modo NO VERI*FACTU, nada pendiente, sin incidencia.
    const estado = await estadoRemision(A, empresa.id);
    assert.deepEqual([estado.modo, estado.pendientes, estado.envios.NO_APLICA, estado.aviso], ['NO_VERIFACTU', 0, 2, null]);
  });

  it('la base de datos impide colar un registro conservado en la cola o sacar de ella uno pendiente', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Guardas de Cola');
    const [pendiente] = await emitir(A, empresa, tickets);
    await db.update(empresas).set({ modoVerifactu: 'NO_VERIFACTU' }).where(eq(empresas.id, empresa.id));
    const local = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));

    const cambiar = (registroId: string, estado: 'PENDIENTE' | 'ENVIANDO' | 'ACEPTADO' | 'NO_APLICA' | 'RECHAZADO') =>
      db.update(enviosAeat).set({ estado }).where(eq(enviosAeat.registroId, registroId));

    // Un registro NO VERI*FACTU no puede entrar en el circuito de remisión…
    await assert.rejects(cambiar(local.id, 'PENDIENTE'), /estado final \(NO_APLICA\)/);
    await assert.rejects(cambiar(local.id, 'ENVIANDO'), /estado final \(NO_APLICA\)/);
    await assert.rejects(cambiar(local.id, 'ACEPTADO'), /estado final \(NO_APLICA\)/);
    // …ni uno VERI*FACTU pendiente puede retirarse de él, ni darse por resuelto sin haberlo enviado.
    await assert.rejects(cambiar(pendiente.id, 'NO_APLICA'), /transición de envío no permitida/);
    await assert.rejects(cambiar(pendiente.id, 'ACEPTADO'), /sin haberse intentado/);
    await assert.rejects(cambiar(pendiente.id, 'RECHAZADO'), /sin haberse intentado/);
    // La cola no se alimenta ni se vacía a mano, y la evidencia de los envíos no se borra.
    await assert.rejects(db.delete(enviosAeat).where(eq(enviosAeat.registroId, pendiente.id)), /permission denied/);
    await assert.rejects(db.delete(aeatLotes).where(eq(aeatLotes.empresaId, empresa.id)), /permission denied/);
    await assert.rejects(db.delete(aeatControlFlujo).where(eq(aeatControlFlujo.empresaId, empresa.id)), /permission denied/);
    await assert.rejects(db.insert(aeatControlFlujo).values({ empresaId: empresa.id }), /permission denied/);

    assert.deepEqual((await colaDe(empresa.id)).map((e) => e.estado), ['PENDIENTE', 'NO_APLICA']);
  });

  it('un lote cerrado es evidencia: su resultado no se puede reescribir', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Evidencia');
    await emitir(A, empresa, tickets);
    const { loteId } = await remitirPendientesDeEmpresa(empresa.id, deps(new Reloj()));
    await assert.rejects(db.update(aeatLotes).set({ csv: 'FALSO' }).where(eq(aeatLotes.id, loteId!)), /ya está cerrado/);
    await assert.rejects(db.update(aeatLotes).set({ resultado: 'INCORRECTO' }).where(eq(aeatLotes.id, loteId!)), /ya está cerrado/);
  });

  it('remisión por requerimiento (art. 14.2 RD): entrega manual de los registros conservados, firmados', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Fontanería Requerida');
    const reloj = new Reloj();
    const [veri] = await emitir(A, empresa, tickets);
    await remitirPendientesDeEmpresa(empresa.id, deps(reloj));
    await db.update(empresas).set({ modoVerifactu: 'NO_VERIFACTU' }).where(eq(empresas.id, empresa.id));
    const local1 = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));
    const local2 = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));

    const r = await remitirPorRequerimiento(A, empresa.id, { refRequerimiento: 'REQ2026000000123' }, deps(reloj));
    assert.deepEqual(
      [r.resultado, r.enviados, r.finRequerimiento, r.siguienteSecuencia, r.error, r.tiempoEsperaSeg],
      ['CORRECTO', 2, true, null, null, 60]
    );
    assert.match(r.csv!, /^A-SIMULADOR/);
    assert.deepEqual(r.registros.map((x) => [x.registroId, x.numSecuencia, x.estadoRegistro]), [
      [local1.id, 2, 'Correcto'],
      [local2.id, 3, 'Correcto'],
    ]);

    // Va al servicio de requerimientos, con la referencia, cierre del requerimiento y la firma de cada registro.
    const peticion = aeat.de(empresa.nif).at(-1)!;
    assert.deepEqual(
      [peticion.servicio, peticion.refRequerimiento, peticion.finRequerimiento, peticion.incidencia],
      ['RequerimientoSOAP', 'REQ2026000000123', true, false]
    );
    assert.deepEqual(peticion.registros.map((x) => [x.refExterna, x.firmado]), [[local1.id, true], [local2.id, true]]);
    // El registro que se remitió en su día como VERI*FACTU no forma parte de la respuesta al requerimiento.
    assert.ok(!peticion.xml.includes(veri.id));

    // Queda constancia en un lote propio, y los registros siguen fuera de la cola.
    const lote = (await lotesDe(empresa.id)).find((l) => l.id === r.loteId)!;
    assert.deepEqual(
      [lote.tipoRemision, lote.refRequerimiento, lote.resultado, lote.numRegistros, lote.primerNumSecuencia, lote.ultimoNumSecuencia],
      ['REQUERIMIENTO', 'REQ2026000000123', 'CORRECTO', 2, 2, 3]
    );
    assert.equal((lote.resultadoRegistros as unknown[]).length, 2);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => e.estado), ['ACEPTADO', 'NO_APLICA', 'NO_APLICA']);

    // Se puede acotar el tramo; si la AEAT no responde, no hay reintento automático y se informa.
    aeat.encolar({ tipo: 'http', estado: 503 });
    const fallo = await remitirPorRequerimiento(A, empresa.id, { refRequerimiento: 'REQ2026000000123', desdeSecuencia: 3, hastaSecuencia: 3 }, deps(reloj));
    assert.deepEqual([fallo.resultado, fallo.enviados, fallo.finRequerimiento, fallo.siguienteSecuencia, fallo.error?.codigo], ['ERROR_TRANSITORIO', 1, false, 3, 'HTTP_503']);

    // Controles de acceso y de entrada.
    const miembro: ContextoUsuario = { ...A, rol: 'member' };
    await rechazaCon('SIN_PERMISO', remitirPorRequerimiento(miembro, empresa.id, { refRequerimiento: 'X' }, deps(reloj)));
    await rechazaCon('NO_ENCONTRADO', remitirPorRequerimiento(B, empresa.id, { refRequerimiento: 'X' }, deps(reloj)));
    await rechazaCon('VALIDACION', remitirPorRequerimiento(A, empresa.id, { refRequerimiento: '' }, deps(reloj)));
    await rechazaCon('VALIDACION', remitirPorRequerimiento(A, empresa.id, { refRequerimiento: 'x'.repeat(19) }, deps(reloj)));
    await rechazaCon('NO_ENCONTRADO', remitirPorRequerimiento(A, empresa.id, { refRequerimiento: 'X', desdeSecuencia: 99 }, deps(reloj)), /NO VERI\*FACTU/);
  });

  it('exportación y comprobación de la conservación local', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Albañilería Conservada');
    const [veri] = await emitir(A, empresa, tickets);
    await db.update(empresas).set({ modoVerifactu: 'NO_VERIFACTU' }).where(eq(empresas.id, empresa.id));
    const local = await emitirNoVerifactuSimulado(A, empresa, await crearBorrador(empresa, tickets));

    // Volcado a ficheros: un XML por registro, tal como se conserva.
    const { ficheros, siguienteSecuencia } = await exportarRegistros(A, empresa.id);
    assert.equal(siguienteSecuencia, null);
    assert.deepEqual(ficheros.map((f) => [f.nombre, f.huella, f.firmado]), [
      [`${empresa.nif}_0000000001_ALTA.xml`, veri.huella, false],
      [`${empresa.nif}_0000000002_ALTA.xml`, local.huella, true],
    ]);
    assert.equal(ficheros[1].contenido, `<?xml version="1.0" encoding="UTF-8"?>\n${local.xmlRegistro}`);
    if (xsdDisponible) {
      for (const f of ficheros) assert.equal(erroresXsd(f.contenido, 'SuministroInformacion.xsd'), null, f.nombre);
    }
    assert.deepEqual((await exportarRegistros(A, empresa.id, { desdeSecuencia: 2 })).ficheros.map((f) => f.numSecuencia), [2]);
    await rechazaCon('NO_ENCONTRADO', exportarRegistros(B, empresa.id));
    await rechazaCon('SIN_PERMISO', exportarRegistros({ ...A, rol: 'member' }, empresa.id));

    // Conservación: cadena íntegra, registros firmados y fuera de la remisión automática.
    const informe = await verificarConservacion(A, empresa.id);
    assert.deepEqual(
      [informe.correcto, informe.cadena.integra, informe.cadena.registrosVerificados, informe.registrosConservados, informe.sinFirma, informe.enColaIndebida],
      [true, true, 2, 1, 0, 0]
    );
    await rechazaCon('NO_ENCONTRADO', verificarConservacion(B, empresa.id));
  });

  it('emitir y anular siguen bloqueados en modo NO VERI*FACTU hasta que exista la firma electrónica', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Bar Aún No');
    const emitida = await crearBorrador(empresa, tickets);
    await emitirFactura(A, empresa.id, emitida);
    await db.update(empresas).set({ modoVerifactu: 'NO_VERIFACTU' }).where(eq(empresas.id, empresa.id));

    await rechazaCon('VALIDACION', emitirFactura(A, empresa.id, await crearBorrador(empresa, tickets)), /NO VERI\*FACTU todavía no está disponible/);
    await rechazaCon('VALIDACION', anularFactura(A, empresa.id, emitida), /NO VERI\*FACTU todavía no está disponible/);
  });
});

/* ========================================================================== */
/*  5. Aislamiento entre cuentas y configuración                              */
/* ========================================================================== */

describe('Aislamiento y salvaguardas', () => {
  it('una cuenta no consulta ni fuerza la remisión de las empresas de otra', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Peluquería Privada');
    await emitir(A, empresa, tickets);
    await rechazaCon('NO_ENCONTRADO', estadoRemision(B, empresa.id));
    await rechazaCon('NO_ENCONTRADO', reintentarRemision(B, empresa.id, deps(new Reloj())));
    assert.equal(aeat.de(empresa.nif).length, 0);
    assert.deepEqual((await colaDe(empresa.id)).map((e) => e.estado), ['PENDIENTE']);
  });

  it('sin los datos del productor no se genera ningún registro (no se podría corregir después)', async () => {
    const { empresa, tickets } = await nuevaEmpresa(A, 'Clínica Sin Productor');
    const borrador = await crearBorrador(empresa, tickets);
    const nif = process.env.VERIFACTU_PRODUCTOR_NIF;
    delete process.env.VERIFACTU_PRODUCTOR_NIF;
    try {
      await rechazaCon('INTEGRIDAD', emitirFactura(A, empresa.id, borrador), /productor/);
    } finally {
      process.env.VERIFACTU_PRODUCTOR_NIF = nif;
    }
    // La emisión se deshizo entera: sigue siendo un borrador sin número y no hay nada en la cola.
    const [factura] = await db.select().from(facturas).where(eq(facturas.id, borrador));
    assert.deepEqual([factura.estado, factura.numero], ['BORRADOR', null]);
    assert.equal((await colaDe(empresa.id)).length, 0);
  });
});
