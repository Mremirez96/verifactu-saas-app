import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbOrTx, Transaction } from '@/lib/db/drizzle';
import {
  enviosAeat,
  facturas,
  facturasDesglose,
  facturasRelacionadas,
  registrosVerifactu,
  type EnvioAeat,
  type Factura,
  type FacturaDesglose,
  type FacturaRelacionada,
  type NewRegistroVerifactu,
  type RegistroVerifactu,
} from '@/lib/db/schema';

/**
 * Acceso a datos de la cadena de registros de facturación. Sin reglas de
 * negocio.
 *
 * Las funciones que solo tienen sentido DENTRO de una transacción reciben
 * `Transaction` y no `DbOrTx`: pasarles la conexión normal es un error de
 * compilación, no un fallo en producción.
 */

/** Cabecera de la cadena tal como la devuelve `vf_bloquear_cadena()`. */
export type CabeceraCadena = {
  ultimoId: string | null;
  ultimaHuella: string | null;
  ultimoNumSecuencia: number;
};

type TipoCadena = 'FACTURACION' | 'EVENTOS';

/**
 * Toma el cerrojo de la cadena de UNA empresa y devuelve su último eslabón.
 *
 * `vf_bloquear_cadena` hace SELECT ... FOR UPDATE sobre la fila de
 * `cadenas_fiscales` con los permisos del propietario (la app solo tiene
 * lectura sobre esa tabla). El bloqueo:
 *   · dura hasta el COMMIT o ROLLBACK de `tx`, no hay que liberarlo;
 *   · es por empresa y tipo de cadena: otras empresas no esperan;
 *   · hace que una segunda transacción de la misma empresa ESPERE aquí y, al
 *     continuar, lea ya la huella que dejó la primera. Por eso la huella
 *     anterior se lee SIEMPRE a través de esta función y nunca antes.
 *
 * El `lock_timeout` evita que una transacción colgada deje esperando sin
 * límite a las demás emisiones de esa empresa.
 */
export async function bloquearCadena(
  tx: Transaction,
  empresaId: string,
  tipo: TipoCadena,
  esperaMaximaMs = 10_000
): Promise<CabeceraCadena | undefined> {
  // SET LOCAL solo vive dentro de la transacción en curso. No admite parámetros,
  // así que el valor se valida como entero antes de componer la sentencia.
  const espera = Math.trunc(esperaMaximaMs);
  if (!Number.isSafeInteger(espera) || espera <= 0) {
    throw new Error(`Espera de cerrojo no válida: ${esperaMaximaMs}`);
  }
  await tx.execute(sql.raw(`SET LOCAL lock_timeout = '${espera}ms'`));

  const [fila] = await tx.execute<{
    ultimo_id: string | null;
    ultima_huella: string | null;
    ultimo_num_secuencia: string | number;
  }>(sql`
    SELECT ultimo_id, ultima_huella, ultimo_num_secuencia
      FROM vf_bloquear_cadena(${empresaId}::uuid, ${tipo}::tipo_cadena)`);

  if (!fila) return undefined;
  return {
    ultimoId: fila.ultimo_id,
    ultimaHuella: fila.ultima_huella,
    ultimoNumSecuencia: Number(fila.ultimo_num_secuencia),
  };
}

/**
 * Hora del servidor de base de datos en este instante.
 *
 * Se usa `clock_timestamp()` y no `now()`: `now()` es la hora de INICIO de la
 * transacción, anterior a la espera por el cerrojo, y dos emisiones
 * simultáneas podrían quedar fechadas en orden inverso al de la cadena.
 * Además, al ser un único reloj para todos los servidores de la aplicación,
 * no hay desfases entre ellos.
 */
export async function horaServidor(tx: Transaction): Promise<Date> {
  const [fila] = await tx.execute<{ ahora: string }>(
    sql`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ahora`
  );
  return new Date(fila.ahora);
}

/** Carga una factura de la empresa bloqueando su fila mientras se emite. */
export async function buscarFacturaParaEmitir(
  tx: Transaction,
  empresaId: string,
  facturaId: string
): Promise<Factura | undefined> {
  const [factura] = await tx
    .select()
    .from(facturas)
    .where(and(eq(facturas.empresaId, empresaId), eq(facturas.id, facturaId)))
    .limit(1)
    .for('update');
  return factura;
}

/** Paso BORRADOR → EMITIDA. El número lo asigna un trigger y vuelve en el RETURNING. */
export async function marcarEmitida(
  tx: Transaction,
  empresaId: string,
  facturaId: string,
  fotoFija: Pick<Factura, 'emisorNif' | 'emisorNombreRazon' | 'emisorDomicilio' | 'fechaExpedicion'>
): Promise<Factura> {
  const [emitida] = await tx
    .update(facturas)
    .set({ ...fotoFija, estado: 'EMITIDA' })
    .where(and(eq(facturas.empresaId, empresaId), eq(facturas.id, facturaId)))
    .returning();
  return emitida;
}

/** Paso EMITIDA → ANULADA. El resto de la factura sigue congelado (trigger). */
export async function marcarAnulada(
  tx: Transaction,
  empresaId: string,
  facturaId: string,
  instante: Date
): Promise<Factura> {
  const [anulada] = await tx
    .update(facturas)
    .set({ estado: 'ANULADA', anuladaEn: instante })
    .where(and(eq(facturas.empresaId, empresaId), eq(facturas.id, facturaId)))
    .returning();
  return anulada;
}

/** Bloque «Desglose» congelado con la factura, en orden estable. */
export async function leerDesglose(dbx: DbOrTx, empresaId: string, facturaId: string): Promise<FacturaDesglose[]> {
  return dbx
    .select()
    .from(facturasDesglose)
    .where(and(eq(facturasDesglose.empresaId, empresaId), eq(facturasDesglose.facturaId, facturaId)))
    .orderBy(
      asc(facturasDesglose.impuesto),
      asc(facturasDesglose.claveRegimen),
      sql`${facturasDesglose.tipoImpositivo} DESC NULLS LAST`,
      asc(facturasDesglose.id)
    );
}

/** Facturas rectificadas o sustituidas por esta. */
export async function leerRelacionadas(
  dbx: DbOrTx,
  empresaId: string,
  facturaId: string
): Promise<FacturaRelacionada[]> {
  return dbx
    .select()
    .from(facturasRelacionadas)
    .where(and(eq(facturasRelacionadas.empresaId, empresaId), eq(facturasRelacionadas.facturaId, facturaId)))
    .orderBy(asc(facturasRelacionadas.referidaFechaExpedicion), asc(facturasRelacionadas.referidaNumSerie));
}

/** Estado de remisión de cada registro de ALTA de una factura. */
export async function estadosEnvioDeAltas(
  dbx: DbOrTx,
  empresaId: string,
  facturaId: string
): Promise<EnvioAeat['estado'][]> {
  const filas = await dbx
    .select({ estado: enviosAeat.estado })
    .from(registrosVerifactu)
    .innerJoin(enviosAeat, eq(enviosAeat.registroId, registrosVerifactu.id))
    .where(
      and(
        eq(registrosVerifactu.empresaId, empresaId),
        eq(registrosVerifactu.facturaId, facturaId),
        eq(registrosVerifactu.tipoRegistro, 'ALTA')
      )
    );
  return filas.map((f) => f.estado);
}

export async function buscarRegistro(
  dbx: DbOrTx,
  empresaId: string,
  registroId: string
): Promise<RegistroVerifactu | undefined> {
  const [registro] = await dbx
    .select()
    .from(registrosVerifactu)
    .where(and(eq(registrosVerifactu.empresaId, empresaId), eq(registrosVerifactu.id, registroId)))
    .limit(1);
  return registro;
}

export async function insertarRegistro(
  tx: Transaction,
  valores: NewRegistroVerifactu
): Promise<RegistroVerifactu> {
  const [registro] = await tx.insert(registrosVerifactu).values(valores).returning();
  return registro;
}

/** Cadena completa de una empresa, en orden. */
export async function listarCadena(dbx: DbOrTx, empresaId: string): Promise<RegistroVerifactu[]> {
  return dbx
    .select()
    .from(registrosVerifactu)
    .where(eq(registrosVerifactu.empresaId, empresaId))
    .orderBy(asc(registrosVerifactu.numSecuencia));
}
