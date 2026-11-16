import type { ModeloDocumento } from '../modelo';

/**
 * Utilidades comunes de las plantillas.
 *
 * Las plantillas son funciones que devuelven texto HTML; no usan React para
 * que el documento sea un fichero AUTOSUFICIENTE (estilos y QR dentro, sin
 * scripts ni recursos externos): se puede abrir, guardar, reenviar o imprimir
 * en cualquier dispositivo, hoy y dentro de años.
 */

/* --------------------------- HTML seguro por defecto ----------------------- */

/** Fragmento que ya es HTML de confianza (lo ha generado una plantilla). */
export class Html {
  constructor(readonly texto: string) {}
  toString() {
    return this.texto;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapar = (texto: string) => texto.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Marca como HTML de confianza un texto que NO viene del usuario (p. ej. el SVG del QR). */
export const crudo = (texto: string) => new Html(texto);

type Valor = Html | string | number | null | undefined | false | Valor[];

function aTexto(valor: Valor): string {
  if (valor === null || valor === undefined || valor === false) return '';
  if (valor instanceof Html) return valor.texto;
  if (Array.isArray(valor)) return valor.map(aTexto).join('');
  return escapar(String(valor));
}

/**
 * Plantilla etiquetada: TODO lo interpolado se escapa salvo que sea `Html`.
 * Una descripción de línea como `<script>…` se imprime como texto; no hay
 * forma de inyectar marcado desde los datos de una factura por descuido.
 */
export function html(literales: TemplateStringsArray, ...valores: Valor[]): Html {
  return new Html(literales.reduce((acc, literal, i) => acc + literal + (i < valores.length ? aTexto(valores[i]) : ''), ''));
}

/* ------------------------------- piezas comunes ---------------------------- */

/**
 * Bloque del QR tributario. Orden fijo: texto «QR tributario:», imagen y, en
 * VERI*FACTU, la frase obligatoria. Todo con el mismo tamaño de letra que el
 * resto del documento (art. 20.1.b: «bien visibles, similares a los del resto»).
 */
export function bloqueQr(modelo: ModeloDocumento): Html {
  if (!modelo.qr) return html``;
  const { contenido, imagen, leyenda } = modelo.qr;
  return html`
    <div class="qr" data-lado-total-mm="${imagen.ladoTotalMm}" data-lado-simbolo-mm="${imagen.ladoSimboloMm}">
      <p class="qr-texto">${contenido.textoSuperior}</p>
      ${crudo(imagen.svg)}
      ${leyenda && html`<p class="qr-leyenda">${leyenda}</p>`}
      <p class="no-imprimir qr-enlace"><a href="${contenido.url}" rel="noopener noreferrer">Comprobar en la sede de la AEAT</a></p>
    </div>`;
}

/** Aviso de estado: un borrador o una factura anulada no deben pasar por válidos. */
export function avisoEstado(modelo: ModeloDocumento): Html {
  if (modelo.estado === 'BORRADOR') {
    return html`<p class="aviso aviso-borrador">BORRADOR · Documento sin validez fiscal</p>`;
  }
  if (modelo.estado === 'ANULADA') {
    return html`<p class="aviso aviso-anulada">FACTURA ANULADA</p>`;
  }
  return html``;
}

export function pie(modelo: ModeloDocumento): Html {
  return html`<footer class="pie">${modelo.pie.map((linea) => html`<p>${linea}</p>`)}</footer>`;
}

/** Documento HTML completo. Sin scripts: solo marcado y estilos propios. */
export function documento(opciones: { titulo: string; clase: string; estilos: string; cuerpo: Html }): string {
  return html`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opciones.titulo}</title>
<style>${crudo(ESTILOS_COMUNES + opciones.estilos)}</style>
</head>
<body class="${opciones.clase}">
<p class="ayuda no-imprimir">Para guardar o enviar este documento, use «Imprimir» y elija «Guardar como PDF» (escala 100 %).</p>
${opciones.cuerpo}
</body>
</html>`.texto;
}

/**
 * Estilos compartidos. Las medidas del QR van en MILÍMETROS dentro del propio
 * SVG; aquí solo se impide que el navegador lo reescale o lo parta entre páginas.
 */
const ESTILOS_COMUNES = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#111;background:#e9eaec}
p,h1,h2,dl,dd{margin:0}
table{border-collapse:collapse;width:100%}
.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
.qr{text-align:center;break-inside:avoid;page-break-inside:avoid}
.qr-imagen{display:block;margin:1mm auto;flex:none;max-width:none}
.qr-texto,.qr-leyenda{font-size:inherit;font-weight:600}
.qr-enlace{font-size:.85em;margin-top:1mm}
.aviso{text-align:center;font-weight:700;letter-spacing:.06em;border:.5mm solid currentColor;padding:1.5mm;margin-bottom:4mm}
.aviso-borrador{color:#8a5a00}
.aviso-anulada{color:#a01515}
.pie{color:#444;break-inside:avoid}
.ayuda{font-size:13px;text-align:center;padding:8px 12px;color:#333}
@media print{
  body{background:#fff}
  .no-imprimir{display:none!important}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}
`;
