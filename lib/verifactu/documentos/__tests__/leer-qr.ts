/**
 * Utilidades de test: leen el QR tal como quedó incrustado en el HTML.
 *
 * No se fían de que "haya un <svg>": reconstruyen la matriz a partir del
 * trazo, la convierten en imagen y la decodifican con un lector de QR
 * independiente (jsQR), igual que haría la cámara de un móvil.
 */
import jsQRModule from 'jsqr';

// jsQR es CommonJS; según cómo se cargue, la función llega directa o en `.default`.
const jsQR = ((jsQRModule as unknown as { default?: typeof jsQRModule }).default ?? jsQRModule) as typeof jsQRModule;

export type QrIncrustado = {
  /** Texto decodificado del QR (`null` si el lector no consigue leerlo). */
  texto: string | null;
  anchoMm: number;
  altoMm: number;
  /** Módulos por lado de la imagen completa (símbolo + zona de silencio). */
  modulosTotales: number;
  /** Módulos en blanco alrededor del símbolo. */
  zonaSilencio: number;
};

export function leerQrDelHtml(html: string): QrIncrustado | null {
  const svg = /<svg[^>]*class="qr-imagen"[^>]*>[\s\S]*?<\/svg>/.exec(html)?.[0];
  if (!svg) return null;

  const atributo = (nombre: string) => new RegExp(`${nombre}="([^"]+)"`).exec(svg)?.[1] ?? '';
  const total = Number(atributo('viewBox').split(' ')[2]);
  const trazo = / d="([^"]*)"/.exec(svg)?.[1] ?? '';

  // Matriz de módulos: true = oscuro.
  const matriz = Array.from({ length: total }, () => new Array<boolean>(total).fill(false));
  for (const [, x, y, ancho] of trazo.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(ancho); i++) matriz[Number(y)][Number(x) + i] = true;
  }

  // Zona de silencio: filas y columnas completamente blancas en los bordes.
  let zonaSilencio = 0;
  while (
    zonaSilencio < total / 2 &&
    matriz[zonaSilencio].every((m) => !m) &&
    matriz.every((fila) => !fila[zonaSilencio])
  ) {
    zonaSilencio++;
  }

  // Imagen RGBA a 6 píxeles por módulo.
  const escala = 6;
  const lado = total * escala;
  const pixeles = new Uint8ClampedArray(lado * lado * 4);
  for (let y = 0; y < lado; y++) {
    for (let x = 0; x < lado; x++) {
      const color = matriz[Math.floor(y / escala)][Math.floor(x / escala)] ? 0 : 255;
      pixeles.set([color, color, color, 255], (y * lado + x) * 4);
    }
  }

  return {
    texto: jsQR(pixeles, lado, lado)?.data ?? null,
    anchoMm: parseFloat(atributo('width')),
    altoMm: parseFloat(atributo('height')),
    modulosTotales: total,
    zonaSilencio,
  };
}

/** Texto visible del CUERPO del documento, sin etiquetas ni espacios repetidos. */
export function textoVisible(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/g, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/g, ' [QR] ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[\s ]+/g, ' ')
    .trim();
}
