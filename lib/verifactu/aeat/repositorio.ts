import { and, asc, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import type { DbOrTx, Transaction } from '@/lib/db/drizzle';
import {
  aeatControlFlujo,
  aeatLotes,
  empresas,
  enviosAeat,
  registrosVerifactu,
  type AeatControlFlujo,
  type AeatLote,
  type EnvioAeat,
  type NewAeatLote,
  type RegistroVerifactu,
} from '@/lib/db/schema';

/**
 * Acceso a datos de la remisión a la AEAT. Sin reglas de negocio: solo SQL.
 *
 * Como en el resto de repositorios, lo que solo tiene sentido dentro de una
 * transacción recibe `Transaction`, y toda consulta lleva `empresa_id`.
 */

/** Estados desde los que un registro está esperando salir hacia la AEAT. */
export const ESTADOS_EN_COLA = ['PENDIENTE', 'ERROR_TRANSITORIO'] as const satisfies readonly EnvioAeat['estado'][];

/** Reloj de la base de datos: el mismo para todos los servidores de la aplicación. */
export async function horaBaseDatos(dbx: DbOrTx): Promise<Date> {
  const [fila] = await dbx.execute<{ ahora: string }>(
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ahora`
  );
  return new Date(fila.ahora);
}

/* -------------------------------------------------------------------------- */
/*  Control de flujo (una fila por empresa; es también el cerrojo de envío)   */
/* -------------------------------------------------------------------------- */

/**
 * Bloquea la fila de control de la empresa hasta el final de la transacción.
 *
 *   · `esperar: false` → SKIP LOCKED: si otro proceso la tiene, devuelve
 *     `undefined` al instante (otro worker ya se ocupa de esta empresa).
 *   · `esperar: true`  → espera su turno (para anotar el resultado de un envío).
 */
export async function bloquearControl(
  tx: Transaction,
  empresaId: string,
  opciones: { esperar: boolean }
): Promise<AeatControlFlujo | undefined> {
  const consulta = tx.select().from(aeatControlFlujo).where(eq(aeatControlFlujo.empresaId, empresaId)).limit(1);
  const [control] = opciones.esperar
    ? await consulta.for('update')
    : await consulta.for('update', { skipLocked: true });
  return control;
}

export async function leerControl(dbx: DbOrTx, empresaId: string): Promise<AeatControlFlujo | undefined> {
  const [control] = await dbx.select().from(aeatControlFlujo).where(eq(aeatControlFlujo.empresaId, empresaId)).limit(1);
  return control;
}

export async function actualizarControl(
  tx: Transaction,
  empresaId: string,
  cambios: Partial<Omit<AeatControlFlujo, 'empresaId' | 'updatedAt'>>
): Promise<void> {
  await tx.update(aeatControlFlujo).set(cambios).where(eq(aeatControlFlujo.empresaId, empresaId));
}

/** Datos del obligado para la cabecera del mensaje. */
export async function leerObligado(
  dbx: DbOrTx,
  empresaId: string
): Promise<{ id: string; nif: string; nombreRazon: string } | undefined> {
  const [empresa] = await dbx
    .select({ id: empresas.id, nif: empresas.nif, nombreRazon: empresas.nombreRazon })
    .from(empresas)
    .where(eq(empresas.id, empresaId))
    .limit(1);
  return empresa;
}

/* -------------------------------------------------------------------------- */
/*  Cola de envíos                                                            */
/* -------------------------------------------------------------------------- */

/** Un registro en cola junto con lo necesario para remitirlo. */
export type EnvioEnCola = {
  registroId: string;
  numSecuencia: number;
  intentos: number;
  entregaIncierta: boolean;
  xmlRegistro: string;
  tipoRegistro: RegistroVerifactu['tipoRegistro'];
  esSubsanacion: boolean;
  numSerieFactura: string;
  modo: RegistroVerifactu['modo'];
};

/**
 * Los primeros registros en cola de la empresa, EN ORDEN DE GENERACIÓN
 * (art. 16.4: la remisión respeta el orden temporal de los registros).
 */
export async function leerEnCola(tx: Transaction, empresaId: string, limite: number): Promise<EnvioEnCola[]> {
  return tx
    .select({
      registroId: enviosAeat.registroId,
      numSecuencia: enviosAeat.numSecuencia,
      intentos: enviosAeat.intentos,
      entregaIncierta: enviosAeat.entregaIncierta,
      xmlRegistro: registrosVerifactu.xmlRegistro,
      tipoRegistro: registrosVerifactu.tipoRegistro,
      esSubsanacion: registrosVerifactu.esSubsanacion,
      numSerieFactura: registrosVerifactu.numSerieFactura,
      modo: registrosVerifactu.modo,
    })
    .from(enviosAeat)
    .innerJoin(
      registrosVerifactu,
      and(eq(registrosVerifactu.id, enviosAeat.registroId), eq(registrosVerifactu.empresaId, enviosAeat.empresaId))
    )
    .where(and(eq(enviosAeat.empresaId, empresaId), inArray(enviosAeat.estado, ESTADOS_EN_COLA)))
    .orderBy(asc(enviosAeat.numSecuencia))
    .limit(limite);
}

/** Cuántos registros de la empresa faltan por remitir (en cola o en vuelo). */
export async function contarSinRemitir(dbx: DbOrTx, empresaId: string): Promise<number> {
  const [fila] = await dbx
    .select({ n: count() })
    .from(enviosAeat)
    .where(
      and(eq(enviosAeat.empresaId, empresaId), inArray(enviosAeat.estado, [...ESTADOS_EN_COLA, 'ENVIANDO']))
    );
  return Number(fila.n);
}

/** Paso a ENVIANDO de los registros que forman un lote. Devuelve cuántos ha tomado. */
export async function marcarEnviando(
  tx: Transaction,
  empresaId: string,
  registroIds: string[],
  loteId: string,
  ahora: Date
): Promise<number> {
  const filas = await tx
    .update(enviosAeat)
    .set({
      estado: 'ENVIANDO',
      loteId,
      intentos: sql`${enviosAeat.intentos} + 1`,
      enviadoEn: ahora,
      respondidoEn: null,
    })
    .where(
      and(
        eq(enviosAeat.empresaId, empresaId),
        inArray(enviosAeat.registroId, registroIds),
        inArray(enviosAeat.estado, ESTADOS_EN_COLA)
      )
    )
    .returning({ id: enviosAeat.registroId });
  return filas.length;
}

/**
 * Devuelve a la cola (ERROR_TRANSITORIO) los registros en vuelo: los de un
 * lote concreto o, sin `loteId`, todos los de la empresa (recuperación de un
 * envío interrumpido). `entregaIncierta` solo se activa, nunca se apaga aquí.
 */
export async function devolverACola(
  tx: Transaction,
  empresaId: string,
  datos: {
    loteId?: string;
    registroIds?: string[];
    codigoError: string;
    descripcionError: string;
    entregaIncierta: boolean;
    proximoIntentoEn: Date;
    ahora: Date;
  }
): Promise<number> {
  const filas = await tx
    .update(enviosAeat)
    .set({
      estado: 'ERROR_TRANSITORIO',
      codigoError: datos.codigoError.slice(0, 10),
      descripcionError: datos.descripcionError,
      entregaIncierta: datos.entregaIncierta ? true : sql`${enviosAeat.entregaIncierta}`,
      proximoIntentoEn: datos.proximoIntentoEn,
      respondidoEn: datos.ahora,
    })
    .where(
      and(
        eq(enviosAeat.empresaId, empresaId),
        eq(enviosAeat.estado, 'ENVIANDO'),
        datos.loteId ? eq(enviosAeat.loteId, datos.loteId) : undefined,
        datos.registroIds ? inArray(enviosAeat.registroId, datos.registroIds) : undefined
      )
    )
    .returning({ id: enviosAeat.registroId });
  return filas.length;
}

/** Anota el estado FINAL que la AEAT ha dado a un grupo de registros de un lote. */
export async function cerrarEnvios(
  tx: Transaction,
  empresaId: string,
  loteId: string,
  registroIds: string[],
  datos: {
    estado: 'ACEPTADO' | 'ACEPTADO_CON_ERRORES' | 'RECHAZADO';
    csv: string | null;
    codigoError: string | null;
    descripcionError: string | null;
    respuestaAeat: Record<string, unknown>;
    ahora: Date;
  }
): Promise<number> {
  const filas = await tx
    .update(enviosAeat)
    .set({
      estado: datos.estado,
      csv: datos.csv,
      codigoError: datos.codigoError?.slice(0, 10) ?? null,
      descripcionError: datos.descripcionError,
      respuestaAeat: datos.respuestaAeat,
      entregaIncierta: false,
      respondidoEn: datos.ahora,
    })
    .where(
      and(
        eq(enviosAeat.empresaId, empresaId),
        eq(enviosAeat.loteId, loteId),
        inArray(enviosAeat.registroId, registroIds),
        // Solo registros que siguen sin desenlace: un estado final no se reescribe.
        inArray(enviosAeat.estado, ['ENVIANDO', 'ERROR_TRANSITORIO'])
      )
    )
    .returning({ id: enviosAeat.registroId });
  return filas.length;
}

/** Recuento de envíos de la empresa por estado. */
export async function resumenEnvios(dbx: DbOrTx, empresaId: string): Promise<Record<EnvioAeat['estado'], number>> {
  const filas = await dbx
    .select({ estado: enviosAeat.estado, n: count() })
    .from(enviosAeat)
    .where(eq(enviosAeat.empresaId, empresaId))
    .groupBy(enviosAeat.estado);
  const resumen: Record<EnvioAeat['estado'], number> = {
    NO_APLICA: 0,
    PENDIENTE: 0,
    ENVIANDO: 0,
    ACEPTADO: 0,
    ACEPTADO_CON_ERRORES: 0,
    RECHAZADO: 0,
    ERROR_TRANSITORIO: 0,
  };
  for (const fila of filas) resumen[fila.estado] = Number(fila.n);
  return resumen;
}

/**
 * Empresas con algo que remitir AHORA: tienen registros sin remitir, ningún
 * mensaje en vuelo (o su arrendamiento ha caducado) y ya ha pasado su espera,
 * o bien tienen un mensaje lleno acumulado (art. 16.2.c).
 */
export async function empresasConEnviosListos(dbx: DbOrTx, ahora: Date, limite: number): Promise<string[]> {
  const instante = ahora.toISOString();
  const filas = await dbx.execute<{ empresa_id: string }>(sql`
    SELECT c.empresa_id
      FROM aeat_control_flujo c
     WHERE (c.lote_en_curso_id IS NULL OR c.lote_en_curso_caduca_en <= ${instante}::timestamptz)
       AND EXISTS (SELECT 1 FROM envios_aeat e
                    WHERE e.empresa_id = c.empresa_id
                      AND e.estado IN ('PENDIENTE', 'ERROR_TRANSITORIO', 'ENVIANDO'))
       AND (   c.proximo_envio_en <= ${instante}::timestamptz
            OR (c.fallos_consecutivos = 0
                AND (SELECT count(*) FROM (SELECT 1 FROM envios_aeat e
                                            WHERE e.empresa_id = c.empresa_id
                                              AND e.estado IN ('PENDIENTE', 'ERROR_TRANSITORIO')
                                            LIMIT 1000) lleno) >= 1000))
     ORDER BY c.proximo_envio_en
     LIMIT ${limite}`);
  return [...filas].map((f) => f.empresa_id);
}

/* -------------------------------------------------------------------------- */
/*  Lotes (un mensaje enviado = una fila; evidencia de cada intento)          */
/* -------------------------------------------------------------------------- */

export async function insertarLote(tx: DbOrTx, valores: NewAeatLote): Promise<AeatLote> {
  const [lote] = await tx.insert(aeatLotes).values(valores).returning();
  return lote;
}

/** Cierra un lote EN_CURSO. Devuelve `false` si ya estaba cerrado. */
export async function cerrarLote(
  tx: DbOrTx,
  loteId: string,
  datos: Pick<AeatLote, 'resultado' | 'finalizadoEn'> &
    Partial<
      Pick<
        AeatLote,
        'estadoHttp' | 'csv' | 'tiempoEsperaSeg' | 'codigoError' | 'descripcionError' | 'respuestaXml' | 'resultadoRegistros'
      >
    >
): Promise<boolean> {
  const filas = await tx
    .update(aeatLotes)
    .set({ ...datos, codigoError: datos.codigoError?.slice(0, 20) })
    .where(and(eq(aeatLotes.id, loteId), eq(aeatLotes.resultado, 'EN_CURSO')))
    .returning({ id: aeatLotes.id });
  return filas.length > 0;
}

export async function ultimosLotes(dbx: DbOrTx, empresaId: string, limite: number): Promise<AeatLote[]> {
  return dbx
    .select()
    .from(aeatLotes)
    .where(eq(aeatLotes.empresaId, empresaId))
    .orderBy(desc(aeatLotes.iniciadoEn))
    .limit(limite);
}

/* -------------------------------------------------------------------------- */
/*  Registros conservados (modo NO VERI*FACTU: requerimiento y exportación)   */
/* -------------------------------------------------------------------------- */

/** Tramo de la cadena de una empresa, en orden, opcionalmente de un solo modo. */
export async function leerTramoDeCadena(
  dbx: DbOrTx,
  empresaId: string,
  tramo: { desde: number; hasta?: number; limite: number; modo?: RegistroVerifactu['modo'] }
): Promise<RegistroVerifactu[]> {
  return dbx
    .select()
    .from(registrosVerifactu)
    .where(
      and(
        eq(registrosVerifactu.empresaId, empresaId),
        gte(registrosVerifactu.numSecuencia, tramo.desde),
        tramo.hasta !== undefined ? lte(registrosVerifactu.numSecuencia, tramo.hasta) : undefined,
        tramo.modo ? eq(registrosVerifactu.modo, tramo.modo) : undefined
      )
    )
    .orderBy(asc(registrosVerifactu.numSecuencia))
    .limit(tramo.limite);
}
