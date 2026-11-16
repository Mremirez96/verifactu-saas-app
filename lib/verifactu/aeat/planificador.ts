import { registrarError } from '../errores';
import { procesarCola } from './remision';

/**
 * Worker de remisión DENTRO del proceso de la aplicación.
 *
 * Para despliegues con un servidor de larga vida (contenedor, VPS). Se activa
 * con `VERIFACTU_COLA_INTERVALO_SEG` (p. ej. 60). En plataformas sin procesos
 * persistentes (funciones serverless) NO sirve: ahí la pasada la dispara una
 * tarea programada contra `/api/cron/aeat`.
 *
 * Varias instancias pueden tenerlo activo a la vez: el cerrojo por empresa de
 * la cola impide envíos duplicados.
 */
let temporizador: NodeJS.Timeout | null = null;
let enCurso = false;

export function iniciarPlanificador(): void {
  const intervaloSeg = Number(process.env.VERIFACTU_COLA_INTERVALO_SEG ?? 0);
  if (temporizador || !Number.isFinite(intervaloSeg) || intervaloSeg <= 0) return;

  const pasada = async () => {
    if (enCurso) return; // la pasada anterior aún no ha terminado: no se solapan
    enCurso = true;
    try {
      await procesarCola();
    } catch (error) {
      registrarError('Planificador de remisión a la AEAT', error);
    } finally {
      enCurso = false;
    }
  };

  temporizador = setInterval(pasada, Math.max(15, intervaloSeg) * 1000);
  // El temporizador no debe impedir que el proceso termine.
  temporizador.unref();
  console.info(`[verifactu] Worker de remisión a la AEAT activo cada ${Math.max(15, intervaloSeg)} s.`);
}

export function detenerPlanificador(): void {
  if (temporizador) clearInterval(temporizador);
  temporizador = null;
}
