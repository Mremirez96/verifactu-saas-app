/**
 * ESPERA ENTRE ENVÍOS: CONTROL DE FLUJO Y REINTENTOS
 *
 * Dos reglas distintas deciden cuándo puede salir el siguiente mensaje de una
 * empresa, y se aplica siempre la más restrictiva:
 *
 * 1. CONTROL DE FLUJO (art. 16.2 de la Orden HAC/1177/2024)
 *    Entre dos envíos hay que esperar «t» segundos. «t» vale 60 al empezar y
 *    la AEAT lo actualiza en cada respuesta («TiempoEsperaEnvio»). Única
 *    excepción: si ya hay acumulados 1.000 registros (un mensaje lleno), se
 *    puede enviar sin esperar.
 *
 * 2. REINTENTOS TRAS UN FALLO TÉCNICO (art. 16.4)
 *    Espera exponencial: cada fallo consecutivo duplica la espera,
 *
 *        espera(n) = min( TOPE, BASE × 2^(n−1) )      n = fallos seguidos
 *
 *        n:      1     2     3     4     5      6      7 …
 *        espera: 1 min 2 min 4 min 8 min 16 min 32 min 60 min (tope)
 *
 *    El tope es de una hora porque la Orden obliga a reintentar «al menos
 *    una vez cada hora» mientras queden registros por remitir: la espera
 *    crece para no martillear a un servidor caído, pero nunca más allá.
 *
 *    A la espera se le resta una fracción aleatoria (hasta un 10 %) para que
 *    todas las empresas afectadas por una misma caída no reintenten en el
 *    mismo segundo. Se RESTA, no se suma, para no rebasar nunca la hora.
 *
 * Módulo PURO: no consulta el reloj; recibe los instantes como argumentos.
 */

export const POLITICA_REINTENTOS = {
  /** Espera tras el primer fallo, en segundos. */
  baseSeg: 60,
  factor: 2,
  /** Tope: «al menos una vez cada hora» (art. 16.4). */
  topeSeg: 3600,
  /** Fracción máxima que se resta al azar. */
  dispersion: 0.1,
} as const;

/** «t» inicial del control de flujo (art. 16.2). */
export const TIEMPO_ESPERA_INICIAL_SEG = 60;

/**
 * Segundos de espera tras `fallosConsecutivos` fallos técnicos seguidos.
 * `aleatorio` devuelve un número en [0, 1); se inyecta para poder probarlo.
 */
export function esperaReintentoSeg(fallosConsecutivos: number, aleatorio: () => number = Math.random): number {
  const n = Math.max(1, Math.trunc(fallosConsecutivos));
  const { baseSeg, factor, topeSeg, dispersion } = POLITICA_REINTENTOS;
  // Con n grande 2^(n−1) desborda; se acota el exponente antes de calcular.
  const exponencial = baseSeg * factor ** Math.min(n - 1, 20);
  const acotada = Math.min(topeSeg, exponencial);
  // Una fuente de azar defectuosa no puede alargar la espera ni romper el cálculo.
  const bruto = aleatorio();
  const azar = Number.isFinite(bruto) ? Math.min(Math.max(bruto, 0), 1) : 0;
  return Math.max(1, Math.round(acotada * (1 - dispersion * azar)));
}

/**
 * Instante a partir del cual puede salir el siguiente mensaje de la empresa.
 *
 *   · Tras una RESPUESTA de la AEAT → último envío + «t».
 *   · Tras un FALLO                 → lo que más tarde: (ahora + espera
 *     exponencial) o (último envío + «t»). El control de flujo no se relaja
 *     por el hecho de que el envío anterior fallara.
 */
export function proximoEnvio(datos: {
  ahora: Date;
  ultimoEnvioEn: Date;
  tiempoEsperaSeg: number;
  /** 0 = el último envío obtuvo respuesta. */
  fallosConsecutivos: number;
  aleatorio?: () => number;
}): Date {
  const porFlujo = datos.ultimoEnvioEn.getTime() + datos.tiempoEsperaSeg * 1000;
  if (datos.fallosConsecutivos <= 0) return new Date(porFlujo);
  const porReintento = datos.ahora.getTime() + esperaReintentoSeg(datos.fallosConsecutivos, datos.aleatorio) * 1000;
  return new Date(Math.max(porFlujo, porReintento));
}
