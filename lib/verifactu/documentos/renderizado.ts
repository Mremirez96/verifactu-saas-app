import { construirModelo, type DatosDocumento, type FormatoDocumento, type ModeloDocumento } from './modelo';
import { plantillaFacturaA4 } from './plantillas/factura-a4';
import { plantillaTicket } from './plantillas/ticket';

/**
 * RENDERIZADO (parte pura, sin base de datos)
 *
 *   datos  ──construirModelo──▶  modelo de vista  ──plantilla──▶  HTML
 *
 * El resultado es un documento HTML autosuficiente (estilos y QR dentro, sin
 * scripts) con hoja de estilos de impresión: se ve bien en el móvil y, al
 * imprimir o «guardar como PDF», sale en A4 o en el ancho del papel térmico
 * con el QR a su tamaño reglamentario.
 */

export const FORMATOS: readonly FormatoDocumento[] = ['A4', 'TICKET_80', 'TICKET_58'];

export type DocumentoGenerado = {
  /** Documento HTML completo. */
  html: string;
  formato: FormatoDocumento;
  /** Nombre sugerido para descargarlo. */
  nombreArchivo: string;
  modelo: ModeloDocumento;
};

/**
 * De los datos de una factura a su documento. Sin `formato`, las
 * simplificadas salen como ticket de 80 mm y las completas en A4.
 */
export function renderizarDocumento(datos: DatosDocumento, formato?: FormatoDocumento): DocumentoGenerado {
  const modelo = construirModelo(datos, formato);
  const html = modelo.formato === 'A4' ? plantillaFacturaA4(modelo) : plantillaTicket(modelo);
  const identificador = (modelo.numSerieFactura ?? 'borrador').replace(/[^A-Za-z0-9._-]+/g, '_');
  const tipo = modelo.titulo === 'Factura' ? 'factura' : 'ticket';
  return { html, formato: modelo.formato, nombreArchivo: `${tipo}-${identificador}.html`, modelo };
}
