import QRCode from 'qrcode';
import type { ContenidoQr } from '../crypto';
import { ErrorDominio } from '../errores';

/**
 * Imagen del código QR tributario como SVG vectorial.
 *
 * Por qué SVG y con medidas en milímetros:
 *   · El art. 21.1 de la Orden fija el tamaño IMPRESO (entre 30×30 y 40×40 mm).
 *     Un SVG con `width`/`height` en mm conserva ese tamaño en papel sea cual
 *     sea la resolución de la pantalla o de la impresora; un PNG en píxeles, no.
 *   · Es texto: va incrustado en el HTML, sin ficheros ni peticiones aparte.
 *
 * La matriz la calcula la librería `qrcode` (ISO/IEC 18004); aquí solo se
 * decide el tamaño y se dibuja.
 */

/** Zona de silencio que exige la norma ISO alrededor del símbolo: 4 módulos. */
const ZONA_SILENCIO = 4;
const LADO_MINIMO_MM = 30;
const LADO_MAXIMO_MM = 40;

export type ImagenQr = {
  /** `<svg>…</svg>` listo para incrustar. */
  svg: string;
  /** Versión del QR (1-40) y módulos por lado del símbolo. */
  version: number;
  modulos: number;
  /** Lado del símbolo (la parte con datos), en mm. */
  ladoSimboloMm: number;
  /** Lado total de la imagen, con la zona de silencio, en mm. */
  ladoTotalMm: number;
};

const redondear = (mm: number) => Math.round(mm * 100) / 100;

/**
 * Dibuja el QR de `contenido.url` con el nivel de corrección que indica el
 * propio contenido (M).
 *
 * Tamaño: el SÍMBOLO mide `ladoSimboloMm` (32 mm por defecto) y la imagen
 * completa, con su zona de silencio, no pasa de 40 mm. Así se cumple el rango
 * 30-40 mm tanto si se mide el símbolo como si se mide el conjunto.
 */
export function imagenQr(contenido: ContenidoQr, opciones: { ladoSimboloMm?: number } = {}): ImagenQr {
  const qr = QRCode.create(contenido.url, { errorCorrectionLevel: contenido.nivelCorreccion });
  const n = qr.modules.size;
  const total = n + 2 * ZONA_SILENCIO;

  // El símbolo no baja de 30 mm; el conjunto no sube de 40 mm.
  const maximoSimbolo = (LADO_MAXIMO_MM * n) / total;
  const ladoSimboloMm = redondear(Math.min(Math.max(opciones.ladoSimboloMm ?? 32, LADO_MINIMO_MM), maximoSimbolo));
  if (ladoSimboloMm < LADO_MINIMO_MM) {
    // Solo ocurriría con un QR diminuto (menos de 24 módulos); las URL de cotejo dan 41 o más.
    throw new ErrorDominio('INTEGRIDAD', 'No es posible dibujar el QR entre 30 y 40 mm con su zona de silencio');
  }
  const ladoTotalMm = redondear((ladoSimboloMm * total) / n);

  // Un rectángulo por cada tramo horizontal de módulos oscuros.
  let trazo = '';
  for (let fila = 0; fila < n; fila++) {
    let columna = 0;
    while (columna < n) {
      if (!qr.modules.data[fila * n + columna]) {
        columna++;
        continue;
      }
      const inicio = columna;
      while (columna < n && qr.modules.data[fila * n + columna]) columna++;
      trazo += `M${inicio + ZONA_SILENCIO} ${fila + ZONA_SILENCIO}h${columna - inicio}v1h-${columna - inicio}z`;
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" class="qr-imagen" role="img" aria-label="Código QR tributario" ` +
    `width="${ladoTotalMm}mm" height="${ladoTotalMm}mm" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path fill="#000" d="${trazo}"/></svg>`;

  return { svg, version: qr.version, modulos: n, ladoSimboloMm, ladoTotalMm };
}
