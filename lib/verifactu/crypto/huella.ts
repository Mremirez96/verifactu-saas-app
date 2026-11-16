import { createHash } from 'node:crypto';
import { ErrorDominio } from '../errores';
import { formatearFecha, formatearImporte, normalizarTexto, PATRON_FECHA_HORA_HUSO } from './formato';

/**
 * HUELLA («hash») DE LOS REGISTROS DE FACTURACIÓN
 *
 * Base: art. 13 de la Orden HAC/1177/2024 y documento técnico de la AEAT
 * «Detalle de las especificaciones técnicas para generación de la huella o
 * hash de los registros de facturación» (v0.1.2).
 *
 * ALGORITMO
 *   1. Se forma una cadena de texto con pares «nombre=valor» unidos por «&»,
 *      en un orden FIJO. Los nombres son los de los campos del registro.
 *   2. Cada valor va sin espacios por delante ni por detrás.
 *   3. La cadena se codifica en UTF-8 y se le aplica SHA-256.
 *   4. El resultado se expresa en hexadecimal y en MAYÚSCULAS (64 caracteres).
 *
 * POR QUÉ ESTO ENCADENA
 *   Uno de los valores de la cadena es la huella del registro ANTERIOR:
 *
 *      H(n) = SHA-256( datos(n) & Huella=H(n-1) & fecha-hora(n) )
 *
 *   Así H(n) depende de H(n-1), que depende de H(n-2)... hasta el primero.
 *   Cambiar un céntimo en el registro k cambia H(k); como H(k) está dentro de
 *   la cadena de k+1, cambia H(k+1), y así hasta el final. No hay forma de
 *   alterar un registro antiguo sin recalcular TODOS los posteriores, y la
 *   última huella dejaría de coincidir con la que ya conocen la AEAT (modo
 *   VERI*FACTU) y los registros firmados (modo NO VERI*FACTU).
 *
 * Este módulo es PURO: no accede a base de datos, reloj ni red. Dados los
 * mismos datos devuelve siempre la misma huella, y por eso se puede probar
 * contra los ejemplos oficiales de la AEAT (ver __tests__/huella.test.ts).
 */

/** Lista L2 del anexo de la Orden. */
export const TIPOS_FACTURA = ['F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5'] as const;
export type TipoFactura = (typeof TIPOS_FACTURA)[number];

/** «TipoHuella» (lista L12): 01 = SHA-256. */
export const TIPO_HUELLA_SHA256 = '01';

const PATRON_HUELLA = /^[0-9A-F]{64}$/;
const PATRON_NIF = /^[A-Z0-9]{9}$/;

/** Datos del registro de ALTA que entran en la huella (art. 13.1.a). */
export type DatosHuellaAlta = {
  /** NIF del obligado a expedir la factura. */
  idEmisorFactura: string;
  /** Nº de serie + nº de factura. */
  numSerieFactura: string;
  /** Fecha de expedición, YYYY-MM-DD (como la guarda la base de datos). */
  fechaExpedicion: string;
  tipoFactura: TipoFactura;
  /** Cuotas repercutidas + recargos de equivalencia. */
  cuotaTotal: string | number;
  importeTotal: string | number;
  /** Huella del registro anterior; `null` si es el primer registro de la cadena. */
  huellaAnterior: string | null;
  /** YYYY-MM-DDThh:mm:ss+hh:mm */
  fechaHoraHusoGen: string;
};

/** Datos del registro de ANULACIÓN que entran en la huella (art. 13.1.b). */
export type DatosHuellaAnulacion = Pick<
  DatosHuellaAlta,
  'idEmisorFactura' | 'numSerieFactura' | 'fechaExpedicion' | 'huellaAnterior' | 'fechaHoraHusoGen'
>;

/* -------------------------------------------------------------------------- */
/*  Paso 1: cadena de texto normalizada                                       */
/* -------------------------------------------------------------------------- */

/**
 * Cadena del registro de alta. Orden y nombres EXACTOS que fija la AEAT:
 *
 *   IDEmisorFactura=…&NumSerieFactura=…&FechaExpedicionFactura=…&TipoFactura=…
 *   &CuotaTotal=…&ImporteTotal=…&Huella=…&FechaHoraHusoGenRegistro=…
 *
 * Los valores NO se codifican como URL: aunque la forma recuerde a una query
 * string, una barra o un espacio dentro del número de factura van tal cual.
 * En el primer registro de la cadena «Huella=» va vacío.
 */
export function cadenaRegistroAlta(datos: DatosHuellaAlta): string {
  const comunes = validarComunes(datos);
  if (!TIPOS_FACTURA.includes(datos.tipoFactura)) {
    throw new ErrorDominio('VALIDACION', `Tipo de factura no válido para la huella: "${datos.tipoFactura}"`);
  }

  return [
    `IDEmisorFactura=${comunes.nif}`,
    `NumSerieFactura=${comunes.numSerie}`,
    `FechaExpedicionFactura=${comunes.fecha}`,
    `TipoFactura=${datos.tipoFactura}`,
    `CuotaTotal=${formatearImporte(datos.cuotaTotal)}`,
    `ImporteTotal=${formatearImporte(datos.importeTotal)}`,
    `Huella=${comunes.huellaAnterior}`,
    `FechaHoraHusoGenRegistro=${comunes.fechaHora}`,
  ].join('&');
}

/**
 * Cadena del registro de anulación:
 *
 *   IDEmisorFacturaAnulada=…&NumSerieFacturaAnulada=…
 *   &FechaExpedicionFacturaAnulada=…&Huella=…&FechaHoraHusoGenRegistro=…
 */
export function cadenaRegistroAnulacion(datos: DatosHuellaAnulacion): string {
  const comunes = validarComunes(datos);
  return [
    `IDEmisorFacturaAnulada=${comunes.nif}`,
    `NumSerieFacturaAnulada=${comunes.numSerie}`,
    `FechaExpedicionFacturaAnulada=${comunes.fecha}`,
    `Huella=${comunes.huellaAnterior}`,
    `FechaHoraHusoGenRegistro=${comunes.fechaHora}`,
  ].join('&');
}

/** Normaliza y valida los campos comunes a alta y anulación. */
function validarComunes(datos: DatosHuellaAnulacion) {
  const nif = normalizarTexto(datos.idEmisorFactura);
  const numSerie = normalizarTexto(datos.numSerieFactura);
  const fechaHora = normalizarTexto(datos.fechaHoraHusoGen);
  const huellaAnterior = datos.huellaAnterior === null ? '' : normalizarTexto(datos.huellaAnterior);

  if (!PATRON_NIF.test(nif)) {
    throw new ErrorDominio('VALIDACION', `NIF del emisor no válido para la huella: "${datos.idEmisorFactura}"`);
  }
  if (numSerie.length === 0 || numSerie.length > 60) {
    throw new ErrorDominio('VALIDACION', 'El número de serie y factura debe tener entre 1 y 60 caracteres');
  }
  if (!PATRON_FECHA_HORA_HUSO.test(fechaHora)) {
    throw new ErrorDominio(
      'VALIDACION',
      `Fecha-hora de generación no válida: "${datos.fechaHoraHusoGen}" (se espera YYYY-MM-DDThh:mm:ss+hh:mm)`
    );
  }
  // Un '' aquí significaría "primer registro" por descuido: se exige null explícito.
  if (datos.huellaAnterior !== null && !PATRON_HUELLA.test(huellaAnterior)) {
    throw new ErrorDominio(
      'VALIDACION',
      'La huella anterior debe ser null (primer registro) o 64 caracteres hexadecimales en mayúsculas'
    );
  }

  return { nif, numSerie, fecha: formatearFecha(datos.fechaExpedicion), fechaHora, huellaAnterior };
}

/* -------------------------------------------------------------------------- */
/*  Pasos 2-4: SHA-256 sobre UTF-8, en hexadecimal y mayúsculas               */
/* -------------------------------------------------------------------------- */

export function sha256Hex(texto: string): string {
  return createHash('sha256').update(texto, 'utf8').digest('hex').toUpperCase();
}

export function huellaRegistroAlta(datos: DatosHuellaAlta): string {
  return sha256Hex(cadenaRegistroAlta(datos));
}

export function huellaRegistroAnulacion(datos: DatosHuellaAnulacion): string {
  return sha256Hex(cadenaRegistroAnulacion(datos));
}

export function esHuellaValida(valor: unknown): valor is string {
  return typeof valor === 'string' && PATRON_HUELLA.test(valor);
}
