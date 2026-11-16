import { ErrorDominio } from '../errores';

/**
 * Utilidades mínimas para ESCRIBIR XML.
 *
 * Los mensajes que se remiten a la AEAT son pequeños y de estructura fija, así
 * que se componen como texto con estas tres funciones en lugar de arrastrar un
 * DOM. La regla que las justifica: ningún valor llega al XML sin pasar por
 * `escaparXml`. (Para LEER las respuestas sí se usa un analizador; ver soap.ts.)
 */

/** Espacios de nombres de los servicios VERI*FACTU (WSDL «SistemaFacturacion»). */
export const NS = {
  soapenv: 'http://schemas.xmlsoap.org/soap/envelope/',
  /** Mensaje de remisión: «RegFactuSistemaFacturacion». */
  sum: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroLR.xsd',
  /** Cabecera y registros de facturación: «RegistroAlta», «RegistroAnulacion». */
  sum1: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/SuministroInformacion.xsd',
  /** Respuesta: «RespuestaRegFactuSistemaFacturacion». */
  respuesta: 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/tike/cont/ws/RespuestaSuministro.xsd',
} as const;

// Caracteres que XML 1.0 no admite ni siquiera escapados (controles C0 salvo TAB, LF y CR).
const NO_PERMITIDOS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

/** Escapa un valor para usarlo como contenido de un elemento. */
export function escaparXml(valor: string): string {
  if (NO_PERMITIDOS.test(valor)) {
    throw new ErrorDominio('VALIDACION', 'El texto contiene caracteres de control que no se pueden remitir a la AEAT');
  }
  return valor
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Elemento con contenido de texto. Si el valor es `null`/`undefined` el
 * elemento NO se escribe (campo opcional no informado): en estos esquemas un
 * elemento vacío no equivale a un elemento ausente y suele ser un error.
 */
export function campo(nombre: string, valor: string | null | undefined): string {
  if (valor === null || valor === undefined) return '';
  return `<${nombre}>${escaparXml(valor)}</${nombre}>`;
}

/** Elemento contenedor. Los hijos vacíos ('' | false | null) se descartan. */
export function bloque(
  nombre: string,
  hijos: Array<string | false | null | undefined>,
  atributos = ''
): string {
  const contenido = hijos.filter(Boolean).join('');
  return `<${nombre}${atributos ? ` ${atributos}` : ''}>${contenido}</${nombre}>`;
}
