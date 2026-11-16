import { ErrorDominio } from '../errores';
import { formatearFecha, formatearImporte, normalizarTexto } from './formato';

/**
 * CÓDIGO QR TRIBUTARIO (art. 20 y 21 de la Orden HAC/1177/2024 y documento
 * técnico de la AEAT «Detalle de las especificaciones técnicas del código QR
 * de la factura»).
 *
 * El QR NO contiene la huella ni ningún dato criptográfico: es una URL del
 * servicio de cotejo de la AEAT con cuatro datos de la factura. Quien recibe
 * la factura la escanea y la AEAT le dice si esa factura consta (VERI*FACTU)
 * o toma nota de ella (NO VERI*FACTU).
 *
 * Este módulo genera el CONTENIDO del QR y sus condiciones de presentación.
 * Dibujar la imagen (PNG/SVG) es cosa de la capa que maqueta la factura, que
 * debe respetar `nivelCorreccion` y `tamanoMm`.
 */

export type ModoSif = 'VERIFACTU' | 'NO_VERIFACTU';
export type EntornoAeat = 'produccion' | 'pruebas';

/** Servicio de cotejo según modo y entorno. */
const URL_COTEJO: Record<EntornoAeat, Record<ModoSif, string>> = {
  produccion: {
    VERIFACTU: 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR',
    NO_VERIFACTU: 'https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu',
  },
  pruebas: {
    VERIFACTU: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR',
    NO_VERIFACTU: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQRNoVerifactu',
  },
};

export type DatosQr = {
  /** NIF del obligado a expedir la factura. */
  nif: string;
  /** Nº de serie + nº de factura. */
  numSerieFactura: string;
  /** Fecha de expedición, YYYY-MM-DD. */
  fechaExpedicion: string;
  importeTotal: string | number;
  modo: ModoSif;
  entorno: EntornoAeat;
};

export type ContenidoQr = {
  /** Texto exacto que se codifica en el QR (y que va como campo en la factura electrónica). */
  url: string;
  /** Los cuatro datos de la factura, ya con el formato de la URL (sin codificar). */
  parametros: { nif: string; numserie: string; fecha: string; importe: string };
  /** Factura cotejable en la sede de la AEAT (solo modo VERI*FACTU). */
  verificable: boolean;
  /** --- Condiciones de presentación (art. 21.1) --- */
  norma: 'ISO/IEC 18004';
  /** Nivel M (medio) de corrección de errores. */
  nivelCorreccion: 'M';
  /** Lado del cuadrado impreso, en milímetros. */
  tamanoMm: { minimo: 30; maximo: 40 };
  /** Texto que precede al código. */
  textoSuperior: 'QR tributario:';
  /**
   * Frase obligatoria junto al QR cuando el sistema es VERI*FACTU (art. 20.1.b);
   * basta una de las dos formas. `null` en modo NO VERI*FACTU: ahí no puede figurar.
   */
  leyenda: { larga: 'Factura verificable en la sede electrónica de la AEAT'; corta: 'VERI*FACTU' } | null;
};

/**
 * URL del QR:
 *
 *   <servicio>?nif=<NIF>&numserie=<serie+número>&fecha=<DD-MM-AAAA>&importe=<total>
 *
 * A diferencia de la cadena de la huella, aquí los valores SÍ se codifican
 * como URL (UTF-8): una barra en el número de factura viaja como %2F.
 * El importe usa el mismo formateador que la huella y el XML (punto decimal,
 * dos decimales), de modo que el cotejo en la AEAT compara lo mismo que se
 * registró.
 */
export function urlQr(datos: DatosQr): string {
  const p = parametrosQr(datos);
  const servicio = URL_COTEJO[datos.entorno]?.[datos.modo];
  if (!servicio) {
    throw new ErrorDominio('VALIDACION', 'Modo o entorno no válido para el código QR');
  }
  return (
    `${servicio}?nif=${encodeURIComponent(p.nif)}` +
    `&numserie=${encodeURIComponent(p.numserie)}` +
    `&fecha=${encodeURIComponent(p.fecha)}` +
    `&importe=${encodeURIComponent(p.importe)}`
  );
}

function parametrosQr(datos: DatosQr): ContenidoQr['parametros'] {
  const nif = normalizarTexto(datos.nif);
  const numserie = normalizarTexto(datos.numSerieFactura);
  if (!/^[A-Z0-9]{9}$/.test(nif)) {
    throw new ErrorDominio('VALIDACION', `NIF no válido para el código QR: "${datos.nif}"`);
  }
  if (numserie.length === 0 || numserie.length > 60) {
    throw new ErrorDominio('VALIDACION', 'El número de serie y factura debe tener entre 1 y 60 caracteres');
  }
  return {
    nif,
    numserie,
    fecha: formatearFecha(datos.fechaExpedicion),
    importe: formatearImporte(datos.importeTotal),
  };
}

/** Contenido estructurado del QR: la URL más todo lo necesario para imprimirlo bien. */
export function contenidoQr(datos: DatosQr): ContenidoQr {
  const verificable = datos.modo === 'VERIFACTU';
  return {
    url: urlQr(datos),
    parametros: parametrosQr(datos),
    verificable,
    norma: 'ISO/IEC 18004',
    nivelCorreccion: 'M',
    tamanoMm: { minimo: 30, maximo: 40 },
    textoSuperior: 'QR tributario:',
    leyenda: verificable
      ? { larga: 'Factura verificable en la sede electrónica de la AEAT', corta: 'VERI*FACTU' }
      : null,
  };
}
