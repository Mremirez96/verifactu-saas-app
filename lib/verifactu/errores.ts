/**
 * Gestión centralizada de errores del dominio de facturación.
 *
 * Los servicios lanzan SIEMPRE `ErrorDominio`. Las capas de entrada (acciones
 * de servidor y rutas API) lo traducen a un mensaje para el usuario o a un
 * código HTTP; cualquier otro error se considera inesperado y se registra.
 */

export type CodigoError =
  | 'NO_AUTENTICADO'
  | 'SIN_PERMISO'
  | 'NO_ENCONTRADO'
  | 'VALIDACION'
  | 'CONFLICTO' // duplicados, estado incompatible
  | 'REGLA_FISCAL' // lo ha rechazado una guarda VERI*FACTU de la base de datos
  | 'INTEGRIDAD'; // la base de datos no está como debería: hay que investigar

export class ErrorDominio extends Error {
  readonly codigo: CodigoError;
  readonly detalle?: Record<string, unknown>;

  constructor(codigo: CodigoError, mensaje: string, detalle?: Record<string, unknown>) {
    super(mensaje);
    this.name = 'ErrorDominio';
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

/** Prefijo de todos los RAISE EXCEPTION de 0002_verifactu_guardas.sql. */
const PREFIJO_GUARDA = 'VERIFACTU:';

type ErrorPostgres = {
  code: string; // SQLSTATE
  message: string;
  constraint_name?: string;
  table_name?: string;
};

/** Localiza el error del driver, vaya suelto o envuelto en `cause`. */
export function comoErrorPostgres(error: unknown): ErrorPostgres | null {
  let actual = error as { code?: unknown; message?: unknown; cause?: unknown } | undefined;
  for (let nivel = 0; nivel < 4 && actual; nivel++) {
    if (
      typeof actual.code === 'string' &&
      /^[0-9A-Z]{5}$/.test(actual.code) &&
      typeof actual.message === 'string'
    ) {
      return actual as ErrorPostgres;
    }
    actual = actual.cause as typeof actual;
  }
  return null;
}

/**
 * Convierte un error de PostgreSQL en un `ErrorDominio` comprensible.
 * `restricciones` asocia el nombre de una constraint con el mensaje a mostrar.
 * Si no sabe traducirlo, relanza el error original sin tocarlo.
 */
export function traducirErrorBd(
  error: unknown,
  restricciones: Record<string, string> = {}
): never {
  if (error instanceof ErrorDominio) throw error;

  const pg = comoErrorPostgres(error);
  if (pg) {
    // 1) Rechazo de una guarda fiscal: el mensaje ya está redactado en español.
    if (pg.message.startsWith(PREFIJO_GUARDA)) {
      throw new ErrorDominio('REGLA_FISCAL', pg.message.slice(PREFIJO_GUARDA.length).trim(), {
        sqlstate: pg.code,
      });
    }
    // 2) Constraint conocida por el servicio que llama.
    if (pg.constraint_name && restricciones[pg.constraint_name]) {
      throw new ErrorDominio(
        pg.code === '23505' || pg.code === '23503' ? 'CONFLICTO' : 'VALIDACION',
        restricciones[pg.constraint_name],
        { restriccion: pg.constraint_name }
      );
    }
    // 3) Permiso denegado: la app ha intentado algo que su rol no puede hacer.
    //    Nunca debería ocurrir; indica un error de programación o de despliegue.
    if (pg.code === '42501') {
      throw new ErrorDominio(
        'INTEGRIDAD',
        'La base de datos ha denegado la operación al rol de la aplicación',
        { sqlstate: pg.code, tabla: pg.table_name, original: pg.message }
      );
    }
  }
  throw error;
}

/** Registro detallado de errores (punto único para enchufar un logger real). */
export function registrarError(operacion: string, error: unknown, contexto?: Record<string, unknown>) {
  const pg = comoErrorPostgres(error);
  console.error(
    `[verifactu] ${operacion}`,
    JSON.stringify({
      ...contexto,
      tipo: error instanceof Error ? error.name : typeof error,
      codigo: error instanceof ErrorDominio ? error.codigo : undefined,
      mensaje: error instanceof Error ? error.message : String(error),
      detalle: error instanceof ErrorDominio ? error.detalle : undefined,
      sqlstate: pg?.code,
      restriccion: pg?.constraint_name,
    })
  );
}
