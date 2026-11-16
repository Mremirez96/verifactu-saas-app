import type { DbOrTx } from '@/lib/db/drizzle';
import { activityLogs, type ActivityType } from '@/lib/db/schema';
import type { ContextoUsuario } from './contexto';

/**
 * Anota una acción en el registro de actividad de la aplicación.
 *
 * OJO: esto NO es el registro de eventos del RRSIF (tabla `eventos_log`,
 * encadenada con huellas). Es la bitácora de uso de la cuenta. Se escribe en
 * la misma transacción que la operación para que no queden acciones sin anotar
 * ni anotaciones de acciones que no llegaron a confirmarse.
 */
export async function registrarActividad(
  dbx: DbOrTx,
  ctx: ContextoUsuario,
  tipo: ActivityType,
  detalle?: string
): Promise<void> {
  await dbx.insert(activityLogs).values({
    teamId: ctx.teamId,
    userId: ctx.usuarioId,
    action: detalle ? `${tipo}: ${detalle}` : tipo,
    ipAddress: ctx.ip ?? '',
  });
}
