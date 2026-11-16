import { ErrorDominio } from '../errores';

/**
 * Normalización de valores para la huella y el QR.
 *
 * REGLA DE ORO: el texto que entra en la huella tiene que ser, carácter a
 * carácter, el mismo que después se escriba en el XML del registro y en la
 * URL del QR. Por eso estas funciones son el ÚNICO sitio donde se da formato
 * a importes y fechas fiscales; ningún otro módulo debe formatearlos por su
 * cuenta.
 */

/** Valor de un campo sin espacios por delante ni por detrás (norma AEAT). */
export function normalizarTexto(valor: string): string {
  return valor.trim();
}

/**
 * Importe con punto decimal y exactamente dos decimales: "123.1" → "123.10".
 *
 * La especificación de la AEAT admite el importe con o sin ceros a la derecha
 * («123.1 se tratará de la misma forma que 123.10»). Fijamos SIEMPRE dos
 * decimales para que huella, XML y QR compartan una única representación.
 *
 * Se trabaja sobre texto, sin pasar por coma flotante, y NO se redondea: un
 * importe con más de dos decimales es un error de quien lo calculó y debe
 * salir a la luz, no esconderse.
 */
export function formatearImporte(valor: string | number): string {
  const texto = typeof valor === 'number' ? numeroATexto(valor) : valor.trim();
  const partes = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(texto);
  if (!partes) {
    throw new ErrorDominio(
      'VALIDACION',
      `Importe no válido para un registro de facturación: "${valor}" (se espera un número con dos decimales como máximo)`
    );
  }
  const [, signo, enteros, decimales = ''] = partes;
  const sinCeros = enteros.replace(/^0+(?=\d)/, '');
  const resultado = `${sinCeros}.${decimales.padEnd(2, '0')}`;
  // "-0.00" no existe: cero es cero.
  return signo && resultado !== '0.00' ? `-${resultado}` : resultado;
}

function numeroATexto(valor: number): string {
  if (!Number.isFinite(valor)) {
    throw new ErrorDominio('VALIDACION', `Importe no válido: ${valor}`);
  }
  // Solo se aceptan números que ya son exactos a céntimos (p. ej. 12.3 o 12.35).
  const texto = valor.toFixed(2);
  if (Math.abs(Number(texto) - valor) > 1e-9) {
    throw new ErrorDominio('VALIDACION', `El importe ${valor} tiene más de dos decimales`);
  }
  return texto;
}

/** Fecha ISO de la base de datos (YYYY-MM-DD) → formato AEAT (DD-MM-YYYY). */
export function formatearFecha(fechaIso: string): string {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaIso.trim());
  if (!partes || Number.isNaN(Date.parse(`${fechaIso.trim()}T00:00:00Z`))) {
    throw new ErrorDominio('VALIDACION', `Fecha no válida: "${fechaIso}" (se espera YYYY-MM-DD)`);
  }
  const [, anio, mes, dia] = partes;
  return `${dia}-${mes}-${anio}`;
}

/** «FechaHoraHusoGenRegistro»: YYYY-MM-DDThh:mm:ss+hh:mm (ISO 8601 con huso). */
export const PATRON_FECHA_HORA_HUSO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

/**
 * Instante → «FechaHoraHusoGenRegistro» en el huso horario de la empresa
 * (art. 7.e de la Orden: hora del territorio desde el que se expide).
 *
 * El desfase se calcula con la base de datos de husos del sistema, así que el
 * cambio de hora de verano se aplica solo: el mismo huso «Europe/Madrid» da
 * +01:00 en enero y +02:00 en julio.
 */
export function fechaHoraHuso(instante: Date, husoHorario: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: husoHorario,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instante)
      .map((parte) => [parte.type, parte.value])
  );

  // Diferencia entre "la hora local leída como si fuera UTC" y el instante real.
  const localComoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  const desfaseMin = Math.round((localComoUtc - Math.floor(instante.getTime() / 1000) * 1000) / 60_000);
  const signo = desfaseMin < 0 ? '-' : '+';
  const hh = String(Math.floor(Math.abs(desfaseMin) / 60)).padStart(2, '0');
  const mm = String(Math.abs(desfaseMin) % 60).padStart(2, '0');

  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${signo}${hh}:${mm}`;
}

/** Fecha (YYYY-MM-DD) que marca el calendario en ese huso en ese instante. */
export function fechaEnHuso(instante: Date, husoHorario: string): string {
  return fechaHoraHuso(instante, husoHorario).slice(0, 10);
}
