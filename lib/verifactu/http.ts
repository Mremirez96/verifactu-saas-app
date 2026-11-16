import { ErrorDominio, registrarError, type CodigoError } from './errores';

/**
 * Traducción de errores para las capas de entrada (acciones y rutas API).
 * Regla: al usuario solo le llegan los mensajes de `ErrorDominio` pensados
 * para él. Los errores inesperados y los de INTEGRIDAD se registran con todo
 * detalle y se responden con un texto genérico (no se filtran datos internos).
 */

const MENSAJE_GENERICO = 'No se ha podido completar la operación. Inténtelo de nuevo.';

const ESTADO_HTTP: Record<CodigoError, number> = {
  NO_AUTENTICADO: 401,
  SIN_PERMISO: 403,
  NO_ENCONTRADO: 404,
  VALIDACION: 400,
  CONFLICTO: 409,
  REGLA_FISCAL: 422,
  INTEGRIDAD: 500,
};

export function mensajeParaUsuario(operacion: string, error: unknown): string {
  if (error instanceof ErrorDominio && error.codigo !== 'INTEGRIDAD') {
    return error.message;
  }
  registrarError(operacion, error);
  return MENSAJE_GENERICO;
}

/** Respuesta JSON de error para una ruta API. */
export function respuestaError(operacion: string, error: unknown): Response {
  const estado = error instanceof ErrorDominio ? ESTADO_HTTP[error.codigo] : 500;
  const codigo = error instanceof ErrorDominio ? error.codigo : 'ERROR_INTERNO';
  return Response.json({ error: mensajeParaUsuario(operacion, error), codigo }, { status: estado });
}
