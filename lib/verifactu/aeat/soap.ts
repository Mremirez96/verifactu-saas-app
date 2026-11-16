import { XMLParser } from 'fast-xml-parser';
import { formatearFecha } from '../crypto';
import { ErrorDominio } from '../errores';
import { bloque, campo, NS } from './xml';

/**
 * MENSAJES SOAP DE LA REMISIÓN DE REGISTROS DE FACTURACIÓN
 *
 * Operación «RegFactuSistemaFacturacion» del WSDL de la AEAT (SOAP 1.1,
 * document/literal). Sirve igual para la remisión voluntaria «VERI*FACTU» y
 * para responder a un requerimiento; lo que cambia es la URL y la cabecera.
 *
 *   <soapenv:Envelope>
 *     <soapenv:Body>
 *       <sum:RegFactuSistemaFacturacion>
 *         <sum:Cabecera> … obligado, incidencia / requerimiento … </sum:Cabecera>
 *         <sum:RegistroFactura> <sum1:RegistroAlta> … </sum:RegistroFactura>      (1 a 1.000)
 *         <sum:RegistroFactura> <sum1:RegistroAnulacion> … </sum:RegistroFactura>
 *
 * Los registros NO se generan aquí: se incrustan, sin tocar un carácter, tal
 * como se guardaron al emitir la factura (son inalterables y su huella ya
 * está calculada). Módulo PURO: sin red ni base de datos.
 */

/** Máximo de registros por mensaje (anexo de la Orden, apartado 2.2). */
export const MAX_REGISTROS_POR_ENVIO = 1000;

export type CabeceraRemision = {
  /** Obligado a expedir las facturas (la empresa emisora). */
  obligado: { nombreRazon: string; nif: string };
  /** Solo si los registros los ha generado un representante/asesor del obligado. */
  representante?: { nombreRazon: string; nif: string } | null;
  remision:
    | {
        tipo: 'VOLUNTARIA';
        /**
         * «Incidencia» = S: alguno de los registros del mensaje no pudo remitirse
         * a su tiempo por una incidencia técnica (art. 16.4 de la Orden).
         */
        incidencia: boolean;
        /** Renuncia a VERI*FACTU: último día (YYYY-MM-DD) en ese modo (art. 17.3). */
        fechaFinVerifactu?: string | null;
      }
    | {
        tipo: 'REQUERIMIENTO';
        /** Referencia del requerimiento de la AEAT (máx. 18 caracteres). */
        refRequerimiento: string;
        /** TRUE en el último mensaje de la respuesta al requerimiento. */
        finRequerimiento: boolean;
      };
};

/** Compone el sobre SOAP con la cabecera y los registros ya serializados. */
export function construirMensajeRemision(cabecera: CabeceraRemision, registrosXml: string[]): string {
  if (registrosXml.length < 1 || registrosXml.length > MAX_REGISTROS_POR_ENVIO) {
    throw new ErrorDominio(
      'INTEGRIDAD',
      `Un mensaje admite entre 1 y ${MAX_REGISTROS_POR_ENVIO} registros (se han indicado ${registrosXml.length})`
    );
  }

  const persona = (nombre: string, p: { nombreRazon: string; nif: string }) =>
    bloque(`sum1:${nombre}`, [campo('sum1:NombreRazon', p.nombreRazon), campo('sum1:NIF', p.nif)]);

  const { remision } = cabecera;
  let circunstancias: string;
  if (remision.tipo === 'VOLUNTARIA') {
    const hijos = [
      remision.fechaFinVerifactu ? campo('sum1:FechaFinVeriFactu', formatearFecha(remision.fechaFinVerifactu)) : '',
      remision.incidencia ? campo('sum1:Incidencia', 'S') : '',
    ];
    // Sin nada que declarar el bloque se omite (ambos campos son opcionales).
    circunstancias = hijos.some(Boolean) ? bloque('sum1:RemisionVoluntaria', hijos) : '';
  } else {
    const referencia = remision.refRequerimiento.trim();
    if (referencia.length === 0 || referencia.length > 18) {
      throw new ErrorDominio('VALIDACION', 'La referencia del requerimiento debe tener entre 1 y 18 caracteres');
    }
    circunstancias = bloque('sum1:RemisionRequerimiento', [
      campo('sum1:RefRequerimiento', referencia),
      remision.finRequerimiento ? campo('sum1:FinRequerimiento', 'S') : '',
    ]);
  }

  const cuerpo = bloque('sum:RegFactuSistemaFacturacion', [
    bloque('sum:Cabecera', [
      persona('ObligadoEmision', cabecera.obligado),
      cabecera.representante ? persona('Representante', cabecera.representante) : '',
      circunstancias,
    ]),
    ...registrosXml.map((xml) => bloque('sum:RegistroFactura', [sinDeclaracionXml(xml)])),
  ]);

  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    bloque(
      'soapenv:Envelope',
      ['<soapenv:Header/>', bloque('soapenv:Body', [cuerpo])],
      `xmlns:soapenv="${NS.soapenv}" xmlns:sum="${NS.sum}" xmlns:sum1="${NS.sum1}"`
    )
  );
}

/** Un registro incrustado no puede llevar su propia declaración `<?xml … ?>`. */
function sinDeclaracionXml(xml: string): string {
  return xml.replace(/^﻿?\s*<\?xml[^?]*\?>\s*/, '');
}

/* -------------------------------------------------------------------------- */
/*  Respuesta de la AEAT                                                      */
/* -------------------------------------------------------------------------- */

export type EstadoEnvioAeat = 'Correcto' | 'ParcialmenteCorrecto' | 'Incorrecto';
export type EstadoRegistroAeat = 'Correcto' | 'AceptadoConErrores' | 'Incorrecto';

/** Una «RespuestaLinea»: el resultado de UN registro del mensaje. */
export type LineaRespuesta = {
  idEmisorFactura: string;
  numSerieFactura: string;
  /** DD-MM-AAAA, tal como lo devuelve la AEAT. */
  fechaExpedicion: string;
  tipoOperacion: 'Alta' | 'Anulacion';
  subsanacion: boolean;
  /** El identificador del registro que enviamos en «RefExterna», si vuelve. */
  refExterna: string | null;
  estadoRegistro: EstadoRegistroAeat;
  codigoError: string | null;
  descripcionError: string | null;
  /**
   * Solo si se rechaza por duplicado: cómo consta YA ese registro en la AEAT.
   * Es la pieza que permite conciliar un reenvío tras un timeout.
   */
  duplicado: {
    idPeticion: string;
    estado: 'Correcta' | 'AceptadaConErrores' | 'Anulada';
    codigoError: string | null;
    descripcionError: string | null;
  } | null;
};

export type RespuestaAeat =
  | {
      tipo: 'RESPUESTA';
      /** Código Seguro de Verificación: solo si al menos un registro se acepta. */
      csv: string | null;
      nifPresentador: string | null;
      timestampPresentacion: string | null;
      /** «TiempoEsperaEnvio» en segundos; `null` si no viene o no es un número. */
      tiempoEsperaSeg: number | null;
      estadoEnvio: EstadoEnvioAeat;
      lineas: LineaRespuesta[];
    }
  | {
      /** SOAP Fault: la AEAT ha rechazado el mensaje ENTERO sin registrar nada. */
      tipo: 'FAULT';
      /** TRUE = fallo del lado de la AEAT (faultcode …:Server): procede reenviar. */
      delServidor: boolean;
      /** Código de la AEAT extraído de «Codigo[NNNN]. …», si lo trae. */
      codigo: string | null;
      mensaje: string;
    };

const analizador = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true, // los prefijos (env, tikR, tik…) los elige el servidor
  parseTagValue: false, // todo como texto: "000123" no es el número 123
  trimValues: true,
  // Además de &amp; &lt;…, las referencias numéricas (&#225; = á), que la AEAT usa en sus mensajes de error.
  htmlEntities: true,
  isArray: (nombre) => nombre === 'RespuestaLinea',
});

type Nodo = Record<string, unknown>;
const nodo = (valor: unknown): Nodo | null =>
  valor !== null && typeof valor === 'object' && !Array.isArray(valor) ? (valor as Nodo) : null;
const texto = (valor: unknown): string | null => {
  if (typeof valor === 'string') return valor.trim() === '' ? null : valor.trim();
  if (typeof valor === 'number') return String(valor);
  return null;
};

const ESTADOS_ENVIO: readonly string[] = ['Correcto', 'ParcialmenteCorrecto', 'Incorrecto'];
const ESTADOS_REGISTRO: readonly string[] = ['Correcto', 'AceptadoConErrores', 'Incorrecto'];
const ESTADOS_DUPLICADO: readonly string[] = ['Correcta', 'AceptadaConErrores', 'Anulada'];

/**
 * Interpreta el cuerpo de una respuesta HTTP de la AEAT.
 * Devuelve `null` si no es ni una respuesta de remisión ni un SOAP Fault
 * (página de error de un proxy, HTML, cuerpo vacío…): quien llama lo trata
 * como un fallo técnico, nunca como una aceptación ni como un rechazo.
 */
export function interpretarRespuesta(xml: string): RespuestaAeat | null {
  // SOAP no admite DTD: un DOCTYPE en la respuesta no es de la AEAT y no se analiza.
  if (/<!DOCTYPE/i.test(xml)) return null;
  let documento: Nodo | null;
  try {
    documento = nodo(analizador.parse(xml));
  } catch {
    return null;
  }
  const cuerpo = nodo(nodo(documento?.Envelope)?.Body);
  if (!cuerpo) return null;

  const fault = nodo(cuerpo.Fault);
  if (fault) {
    const codigoSoap = texto(fault.faultcode) ?? '';
    const cadena = (texto(fault.faultstring) ?? 'Error no especificado por la AEAT').replace(/\s+/g, ' ');
    // Formato habitual: «Codigo[4104].Error en la cabecera: …»
    const partes = /^Codigo\[(\d+)\]\.?\s*(.*)$/.exec(cadena);
    return {
      tipo: 'FAULT',
      delServidor: /(^|:)Server$/i.test(codigoSoap),
      codigo: partes ? partes[1] : null,
      mensaje: partes ? partes[2] || cadena : cadena,
    };
  }

  const respuesta = nodo(cuerpo.RespuestaRegFactuSistemaFacturacion);
  const estadoEnvio = texto(respuesta?.EstadoEnvio);
  if (!respuesta || !estadoEnvio || !ESTADOS_ENVIO.includes(estadoEnvio)) return null;

  const lineas: LineaRespuesta[] = [];
  for (const bruta of (respuesta.RespuestaLinea as unknown[] | undefined) ?? []) {
    const linea = interpretarLinea(nodo(bruta));
    if (!linea) return null; // una línea ilegible invalida la respuesta entera: no se adivina
    lineas.push(linea);
  }

  const presentacion = nodo(respuesta.DatosPresentacion);
  const espera = texto(respuesta.TiempoEsperaEnvio);
  return {
    tipo: 'RESPUESTA',
    csv: texto(respuesta.CSV),
    nifPresentador: texto(presentacion?.NIFPresentador),
    timestampPresentacion: texto(presentacion?.TimestampPresentacion),
    tiempoEsperaSeg: espera !== null && /^\d{1,4}$/.test(espera) ? Number(espera) : null,
    estadoEnvio: estadoEnvio as EstadoEnvioAeat,
    lineas,
  };
}

function interpretarLinea(linea: Nodo | null): LineaRespuesta | null {
  const id = nodo(linea?.IDFactura);
  const operacion = nodo(linea?.Operacion);
  const estado = texto(linea?.EstadoRegistro);
  const tipoOperacion = texto(operacion?.TipoOperacion);
  // En las anulaciones la AEAT identifica la factura con los nombres «…Anulada».
  const nif = texto(id?.IDEmisorFactura) ?? texto(id?.IDEmisorFacturaAnulada);
  const numSerie = texto(id?.NumSerieFactura) ?? texto(id?.NumSerieFacturaAnulada);
  const fecha = texto(id?.FechaExpedicionFactura) ?? texto(id?.FechaExpedicionFacturaAnulada);

  if (!linea || !nif || !numSerie || !fecha || !estado || !ESTADOS_REGISTRO.includes(estado)) return null;
  if (tipoOperacion !== 'Alta' && tipoOperacion !== 'Anulacion') return null;

  const dup = nodo(linea.RegistroDuplicado);
  const estadoDup = texto(dup?.EstadoRegistroDuplicado);
  return {
    idEmisorFactura: nif,
    numSerieFactura: numSerie,
    fechaExpedicion: fecha,
    tipoOperacion,
    subsanacion: texto(operacion?.Subsanacion) === 'S',
    refExterna: texto(linea.RefExterna),
    estadoRegistro: estado as EstadoRegistroAeat,
    codigoError: texto(linea.CodigoErrorRegistro),
    descripcionError: texto(linea.DescripcionErrorRegistro),
    duplicado:
      dup && estadoDup && ESTADOS_DUPLICADO.includes(estadoDup)
        ? {
            idPeticion: texto(dup.IdPeticionRegistroDuplicado) ?? '',
            estado: estadoDup as 'Correcta' | 'AceptadaConErrores' | 'Anulada',
            codigoError: texto(dup.CodigoErrorRegistro),
            descripcionError: texto(dup.DescripcionErrorRegistro),
          }
        : null,
  };
}
