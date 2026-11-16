import {
  esHuellaValida,
  huellaRegistroAlta,
  huellaRegistroAnulacion,
  type TipoFactura,
} from './huella';

/**
 * VERIFICACIÓN DE LA CADENA DE REGISTROS (art. 6 y 7 de la Orden HAC/1177/2024)
 *
 * Módulo PURO: recibe los registros ya leídos y dice si la cadena es íntegra.
 * No consulta la base de datos, de modo que sirve igual para comprobar la
 * cadena en producción, una exportación o un juego de datos de prueba.
 *
 * Qué se comprueba en cada registro n:
 *   (a) INTEGRIDAD     huella(n) == SHA-256(campos de n)        → anomalía 01
 *   (b) ENCADENAMIENTO huellaAnterior(n) == huella(n-1)         → anomalía 08
 *   (c) PRIMER ESLABÓN solo el primero carece de anterior       → anomalía 04
 *   (d) SECUENCIA      no faltan registros intermedios          → anomalía 05
 *   (e) ORDEN TEMPORAL fecha(n) >= fecha(n-1), y no es futura   → anomalías 11 y 13
 *   (f) ANCLA          la última huella es la esperada          → anomalía 09
 *
 * (a) detecta un registro retocado; (b) detecta que además se recalculó su
 * huella; (f) detecta que se recalculó TODA la cola: la última huella ya no
 * coincide con la que se guardó aparte (cabecera de la cadena, AEAT, firma).
 */

/** Códigos de la lista L1E del anexo de la Orden (tipos de anomalía). */
export const ANOMALIAS = {
  '01': 'Integridad: la huella no corresponde al contenido del registro',
  '04': 'Trazabilidad: registro no primero sin registro anterior',
  '05': 'Trazabilidad: falta el registro posterior (hueco en la cadena)',
  '08': "Trazabilidad: el campo 'huella del registro anterior' no coincide con la huella del registro anterior",
  '09': 'Trazabilidad: la última huella de la cadena no coincide con la esperada',
  '11': 'Trazabilidad: fecha-hora anterior a la del registro anterior',
  '13': 'Trazabilidad: fecha-hora de generación posterior a la actual',
} as const;

export type CodigoAnomalia = keyof typeof ANOMALIAS;

/**
 * Lo mínimo que hace falta de un registro para verificarlo. Coincide con las
 * columnas de `registros_verifactu`, así que una fila de la tabla sirve tal cual.
 */
export type RegistroEncadenado = {
  numSecuencia: number;
  tipoRegistro: 'ALTA' | 'ANULACION';
  idEmisorFactura: string;
  numSerieFactura: string;
  fechaExpedicion: string; // YYYY-MM-DD
  tipoFactura: TipoFactura | null; // solo ALTA
  cuotaTotal: string | null; // solo ALTA
  importeTotal: string | null; // solo ALTA
  esPrimerRegistro: boolean;
  huellaAnterior: string | null;
  fechaHoraHusoGen: string;
  huella: string;
};

export type Anomalia = {
  codigo: CodigoAnomalia;
  descripcion: string;
  /** Posición en la cadena del registro donde se detecta. */
  numSecuencia: number;
  numSerieFactura: string;
};

export type ResultadoVerificacion = {
  integra: boolean;
  registrosVerificados: number;
  anomalias: Anomalia[];
  /** Huella del último registro verificado (`null` si la cadena está vacía). */
  ultimaHuella: string | null;
};

export type OpcionesVerificacion = {
  /**
   * Ancla externa: huella que DEBE tener el último registro (la cabecera de
   * `cadenas_fiscales`, el último acuse de la AEAT...). Sin ancla, una cadena
   * falsificada entera y recalculada de principio a fin parecería íntegra.
   */
  ultimaHuellaEsperada?: string | null;
  /** Instante de referencia para detectar fechas futuras. Por defecto, ahora. */
  ahora?: Date;
  /** Tolerancia en el orden temporal (art. 7.i.2º: un minuto). */
  toleranciaMs?: number;
  /**
   * La lista es un tramo intermedio (verificación parcial, art. 7.h): el
   * primer registro de la lista puede tener anterior fuera de ella.
   */
  tramoParcial?: boolean;
};

/**
 * Recalcula la huella de un registro a partir de SUS PROPIOS campos.
 * Si alguien cambió cualquiera de ellos sin tocar la huella guardada, el
 * resultado no coincidirá con `registro.huella`.
 */
export function recalcularHuella(registro: RegistroEncadenado): string {
  const comunes = {
    idEmisorFactura: registro.idEmisorFactura,
    numSerieFactura: registro.numSerieFactura,
    fechaExpedicion: registro.fechaExpedicion,
    huellaAnterior: registro.huellaAnterior,
    fechaHoraHusoGen: registro.fechaHoraHusoGen,
  };

  if (registro.tipoRegistro === 'ANULACION') {
    return huellaRegistroAnulacion(comunes);
  }
  if (registro.tipoFactura === null || registro.cuotaTotal === null || registro.importeTotal === null) {
    throw new Error(`Registro de alta ${registro.numSerieFactura} sin tipo o importes`);
  }
  return huellaRegistroAlta({
    ...comunes,
    tipoFactura: registro.tipoFactura,
    cuotaTotal: registro.cuotaTotal,
    importeTotal: registro.importeTotal,
  });
}

/** ¿El contenido del registro sigue correspondiendo a su huella? */
export function eslabonIntegro(registro: RegistroEncadenado): boolean {
  try {
    return esHuellaValida(registro.huella) && recalcularHuella(registro) === registro.huella;
  } catch {
    // Un registro cuyos datos ya ni siquiera son válidos tampoco es íntegro.
    return false;
  }
}

/**
 * Verifica una cadena (o un tramo) de registros de UNA empresa.
 * Los registros se ordenan por `numSecuencia` antes de comprobarlos.
 */
export function verificarCadena(
  registros: readonly RegistroEncadenado[],
  opciones: OpcionesVerificacion = {}
): ResultadoVerificacion {
  const ahora = opciones.ahora ?? new Date();
  const tolerancia = opciones.toleranciaMs ?? 60_000;
  const cadena = [...registros].sort((a, b) => a.numSecuencia - b.numSecuencia);
  const anomalias: Anomalia[] = [];

  const anotar = (codigo: CodigoAnomalia, registro: RegistroEncadenado) =>
    anomalias.push({
      codigo,
      descripcion: ANOMALIAS[codigo],
      numSecuencia: registro.numSecuencia,
      numSerieFactura: registro.numSerieFactura,
    });

  cadena.forEach((registro, i) => {
    const anterior = i > 0 ? cadena[i - 1] : null;
    const generado = Date.parse(registro.fechaHoraHusoGen);

    // (a) Integridad del propio registro.
    if (!eslabonIntegro(registro)) anotar('01', registro);

    if (anterior === null) {
      // (c) Inicio de la cadena: sin anterior solo puede estar el primer registro.
      const esInicioReal = registro.esPrimerRegistro && registro.huellaAnterior === null;
      const esInicioDeTramo = opciones.tramoParcial && !registro.esPrimerRegistro && registro.huellaAnterior !== null;
      if (!esInicioReal && !esInicioDeTramo) anotar('04', registro);
    } else {
      // (d) No puede faltar ningún registro entre dos consecutivos.
      if (registro.numSecuencia !== anterior.numSecuencia + 1) anotar('05', anterior);
      // (b) El eslabón: este registro "recuerda" la huella del anterior.
      if (registro.esPrimerRegistro || registro.huellaAnterior !== anterior.huella) anotar('08', registro);
      // (e) El tiempo no retrocede.
      if (generado + tolerancia < Date.parse(anterior.fechaHoraHusoGen)) anotar('11', registro);
    }

    // (e) Ni viene del futuro.
    if (Number.isNaN(generado) || generado > ahora.getTime() + tolerancia) anotar('13', registro);
  });

  const ultimo = cadena.at(-1) ?? null;
  const ultimaHuella = ultimo?.huella ?? null;

  // (f) Ancla externa.
  if (opciones.ultimaHuellaEsperada !== undefined && opciones.ultimaHuellaEsperada !== ultimaHuella) {
    if (ultimo) {
      anotar('09', ultimo);
    } else {
      // Se esperaba una cadena con registros y no hay ninguno.
      anomalias.push({ codigo: '09', descripcion: ANOMALIAS['09'], numSecuencia: 0, numSerieFactura: '' });
    }
  }

  return {
    integra: anomalias.length === 0,
    registrosVerificados: cadena.length,
    anomalias,
    ultimaHuella,
  };
}
