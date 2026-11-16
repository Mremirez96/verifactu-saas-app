import type { SerieFacturacion, Factura } from '@/lib/db/schema';

type TipoSerie = SerieFacturacion['tipoSerie'];
type TipoFactura = Factura['tipoFactura'];

/**
 * Qué tipos de factura (lista L2 de la Orden HAC/1177/2024) admite cada tipo
 * de serie.
 *
 * La única separación que impone la norma es la de las RECTIFICATIVAS, que
 * deben ir en serie específica (art. 6.1.a RD 1619/2012); esa regla la hace
 * cumplir además un trigger de la base de datos. Separar los tickets en su
 * propia serie no es obligatorio, pero es la práctica habitual y la que
 * aplicamos por defecto.
 */
export const TIPOS_FACTURA_POR_SERIE: Record<TipoSerie, readonly TipoFactura[]> = {
  ORDINARIA: ['F1', 'F2', 'F3'],
  SIMPLIFICADA: ['F2'],
  RECTIFICATIVA: ['R1', 'R2', 'R3', 'R4', 'R5'],
};

export function serieAdmiteTipoFactura(tipoSerie: TipoSerie, tipoFactura: TipoFactura): boolean {
  return TIPOS_FACTURA_POR_SERIE[tipoSerie].includes(tipoFactura);
}

/** Tipo de serie en el que se busca la serie por defecto para una factura. */
export function tipoSerieParaFactura(tipoFactura: TipoFactura): TipoSerie {
  if (tipoFactura.startsWith('R')) return 'RECTIFICATIVA';
  return tipoFactura === 'F2' ? 'SIMPLIFICADA' : 'ORDINARIA';
}

/**
 * Ejemplo del «NumSerieFactura» que generará la serie para su próximo número.
 * Replica la fórmula del trigger de emisión (código + número con ceros a la
 * izquierda); es solo para mostrar en pantalla: el número real lo asigna la
 * base de datos al emitir.
 */
export function siguienteNumeroPrevisto(
  serie: Pick<SerieFacturacion, 'codigo' | 'digitosRelleno' | 'ultimoNumero'>
): string {
  const numero = String(serie.ultimoNumero + 1);
  return serie.codigo + numero.padStart(Math.max(serie.digitosRelleno, numero.length), '0');
}
