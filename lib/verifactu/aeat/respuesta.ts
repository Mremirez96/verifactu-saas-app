import type { LineaRespuesta, RespuestaAeat } from './soap';
import { ErrorTransporte, type RespuestaHttp } from './transporte';

/**
 * DE LA RESPUESTA DE LA AEAT AL ESTADO DE CADA ENVÍO
 *
 * Aquí se decide qué significa lo que ha contestado (o no) la AEAT. Módulo
 * PURO: recibe datos y devuelve decisiones; la cola (remision.ts) las aplica.
 *
 * TRES DESENLACES POSIBLES DE UN MENSAJE
 *
 *   A. RESPUESTA    La AEAT ha procesado el mensaje y dice, registro a
 *                   registro, qué ha hecho con él:
 *                     Correcto            → ACEPTADO              (final)
 *                     AceptadoConErrores  → ACEPTADO_CON_ERRORES  (final; hay que subsanar)
 *                     Incorrecto          → RECHAZADO             (final; hay que corregir y
 *                                                                  generar un registro nuevo)
 *
 *   B. TRANSITORIO  No hay respuesta útil: sin cobertura, timeout, error 5xx,
 *                   SOAP Fault «Server»… Nada cambia de estado fiscal; los
 *                   registros vuelven a la cola y se reintenta con espera
 *                   exponencial.
 *
 *   C. RECHAZO DEL ENVÍO  La AEAT rechaza el mensaje ENTERO (SOAP Fault
 *                   «Client»: XML fuera de esquema, cabecera errónea,
 *                   certificado sin permiso…; o HTTP 4xx). Ningún registro ha
 *                   sido registrado NI rechazado individualmente. La causa
 *                   suele ser de configuración, así que NO se marca nada como
 *                   RECHAZADO (sería irreversible): los registros siguen en
 *                   cola y la empresa queda señalada para intervención.
 */

/** Estado final de un registro según la AEAT. */
export type DesenlaceRegistro = {
  estado: 'ACEPTADO' | 'ACEPTADO_CON_ERRORES' | 'RECHAZADO';
  /** CSV del envío en el que se aceptó. `null` si se rechaza o se concilió un duplicado. */
  csv: string | null;
  codigoError: string | null;
  descripcionError: string | null;
  /** TRUE = el estado se ha deducido del bloque «RegistroDuplicado». */
  conciliado: boolean;
};

/**
 * Traduce una línea de respuesta al estado del envío.
 *
 * CONCILIACIÓN DE DUPLICADOS. Si un intento anterior de ESTE registro quedó
 * sin respuesta (`entregaIncierta`), puede que la AEAT sí lo registrara. Al
 * reenviarlo lo rechaza por duplicado y adjunta «RegistroDuplicado» con el
 * estado en que ya consta. En ese caso el rechazo es, en realidad, la
 * confirmación del envío anterior, y el registro se da por aceptado con el
 * estado que la AEAT dice tener.
 *
 * Sin intento previo incierto, un duplicado es un rechazo de verdad: esa
 * factura ya constaba en la AEAT por otra vía (p. ej. numeración repetida con
 * otro programa) y hay que revisarla.
 */
export function desenlaceDeLinea(
  linea: LineaRespuesta,
  contexto: { csv: string | null; entregaIncierta: boolean }
): DesenlaceRegistro {
  if (linea.estadoRegistro === 'Correcto') {
    return { estado: 'ACEPTADO', csv: contexto.csv, codigoError: null, descripcionError: null, conciliado: false };
  }
  if (linea.estadoRegistro === 'AceptadoConErrores') {
    return {
      estado: 'ACEPTADO_CON_ERRORES',
      csv: contexto.csv,
      codigoError: linea.codigoError,
      descripcionError: linea.descripcionError,
      conciliado: false,
    };
  }

  if (linea.duplicado && contexto.entregaIncierta) {
    const conErrores = linea.duplicado.estado === 'AceptadaConErrores';
    return {
      estado: conErrores ? 'ACEPTADO_CON_ERRORES' : 'ACEPTADO',
      // El CSV correspondía al envío que quedó sin respuesta: no lo conocemos.
      csv: null,
      codigoError: conErrores ? linea.duplicado.codigoError : null,
      descripcionError: conErrores ? linea.duplicado.descripcionError : null,
      conciliado: true,
    };
  }

  return {
    estado: 'RECHAZADO',
    csv: null,
    codigoError: linea.codigoError,
    descripcionError: linea.descripcionError,
    conciliado: false,
  };
}

/** Lo mínimo que hay que saber de un registro enviado para casar su línea. */
export type RegistroEnviado = {
  registroId: string;
  numSerieFactura: string;
  tipoRegistro: 'ALTA' | 'ANULACION';
  esSubsanacion: boolean;
};

/**
 * Casa cada registro enviado con su línea de respuesta.
 *
 *   1. Por «RefExterna», que lleva el identificador del registro: inequívoco.
 *   2. Si la AEAT no la devuelve, por (nº de factura, operación, subsanación),
 *      respetando el orden de envío cuando la misma factura aparece varias
 *      veces en el mensaje (p. ej. alta y anulación).
 *
 * Un registro sin línea queda fuera del mapa: la cola lo tratará como «sin
 * respuesta», nunca como aceptado.
 */
export function emparejarLineas(
  enviados: RegistroEnviado[],
  lineas: LineaRespuesta[]
): Map<string, LineaRespuesta> {
  const resultado = new Map<string, LineaRespuesta>();
  const ids = new Set(enviados.map((e) => e.registroId));
  const sinReferencia: LineaRespuesta[] = [];

  for (const linea of lineas) {
    if (linea.refExterna && ids.has(linea.refExterna) && !resultado.has(linea.refExterna)) {
      resultado.set(linea.refExterna, linea);
    } else {
      sinReferencia.push(linea);
    }
  }

  const clave = (numSerie: string, anulacion: boolean, subsanacion: boolean) =>
    `${numSerie}\u0000${anulacion ? 'B' : 'A'}\u0000${subsanacion ? 'S' : 'N'}`;
  const porClave = new Map<string, LineaRespuesta[]>();
  for (const linea of sinReferencia) {
    const k = clave(linea.numSerieFactura, linea.tipoOperacion === 'Anulacion', linea.subsanacion);
    porClave.set(k, [...(porClave.get(k) ?? []), linea]);
  }
  for (const enviado of enviados) {
    if (resultado.has(enviado.registroId)) continue;
    const linea = porClave
      .get(clave(enviado.numSerieFactura, enviado.tipoRegistro === 'ANULACION', enviado.esSubsanacion))
      ?.shift();
    if (linea) resultado.set(enviado.registroId, linea);
  }
  return resultado;
}

/* -------------------------------------------------------------------------- */
/*  Desenlace del mensaje completo                                            */
/* -------------------------------------------------------------------------- */

export type DesenlaceEnvio =
  | { tipo: 'RESPUESTA'; estadoHttp: number; cuerpo: string; respuesta: Extract<RespuestaAeat, { tipo: 'RESPUESTA' }> }
  | {
      tipo: 'TRANSITORIO' | 'RECHAZO_ENVIO';
      estadoHttp: number | null;
      cuerpo: string | null;
      /** Código de la AEAT, HTTP_nnn o el código de red (TIMEOUT, ECONNREFUSED…). */
      codigo: string;
      mensaje: string;
      /** TRUE = la AEAT pudo llegar a procesar el mensaje. */
      entregaIncierta: boolean;
    };

/** Clasifica una respuesta HTTP ya recibida. */
export function clasificarRespuestaHttp(http: RespuestaHttp, respuesta: RespuestaAeat | null): DesenlaceEnvio {
  const base = { estadoHttp: http.estado, cuerpo: http.cuerpo };

  if (respuesta?.tipo === 'RESPUESTA') {
    return { tipo: 'RESPUESTA', ...base, respuesta };
  }

  if (respuesta?.tipo === 'FAULT') {
    const codigo = respuesta.codigo ?? (respuesta.delServidor ? 'FAULT_SERVER' : 'FAULT_CLIENT');
    return respuesta.delServidor
      ? // Fallo del lado de la AEAT: procede reenviar el mismo mensaje. Se marca como
        // incierto por prudencia: si llegó a registrar algo, el reenvío lo dirá.
        { tipo: 'TRANSITORIO', ...base, codigo, mensaje: respuesta.mensaje, entregaIncierta: true }
      : { tipo: 'RECHAZO_ENVIO', ...base, codigo, mensaje: respuesta.mensaje, entregaIncierta: false };
  }

  // Cuerpo que no es SOAP (proxy, balanceador, página de error): decide el código HTTP.
  const codigo = `HTTP_${http.estado}`;
  if (http.estado >= 500 || http.estado === 408 || http.estado === 429) {
    return {
      tipo: 'TRANSITORIO',
      ...base,
      codigo,
      mensaje: `La AEAT ha respondido con un error temporal (HTTP ${http.estado})`,
      // Con 429 el mensaje no se ha procesado; con el resto no se puede saber.
      entregaIncierta: http.estado !== 429,
    };
  }
  if (http.estado >= 400) {
    // 401/403: certificado no admitido; 404: URL de servicio incorrecta…
    return {
      tipo: 'RECHAZO_ENVIO',
      ...base,
      codigo,
      mensaje: `La AEAT ha rechazado la conexión o el mensaje (HTTP ${http.estado})`,
      entregaIncierta: false,
    };
  }
  // 2xx/3xx con un cuerpo que no se entiende: ni aceptado ni rechazado.
  return {
    tipo: 'TRANSITORIO',
    ...base,
    codigo: 'RESPUESTA_ILEGIBLE',
    mensaje: `Respuesta de la AEAT no reconocida (HTTP ${http.estado})`,
    entregaIncierta: true,
  };
}

/** Clasifica un fallo ocurrido antes de tener respuesta. */
export function clasificarErrorDeEnvio(error: unknown): DesenlaceEnvio {
  if (error instanceof ErrorTransporte) {
    return {
      tipo: 'TRANSITORIO',
      estadoHttp: null,
      cuerpo: null,
      codigo: error.codigo,
      mensaje: error.message,
      entregaIncierta: error.entregaIncierta,
    };
  }
  // Error inesperado del propio transporte: se asume lo peor (pudo salir).
  return {
    tipo: 'TRANSITORIO',
    estadoHttp: null,
    cuerpo: null,
    codigo: 'ERROR_INTERNO',
    mensaje: error instanceof Error ? error.message : String(error),
    entregaIncierta: true,
  };
}
