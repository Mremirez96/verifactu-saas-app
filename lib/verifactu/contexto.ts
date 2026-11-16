import { ErrorDominio } from './errores';

/**
 * Quién ejecuta una operación y para qué cuenta. Los servicios reciben el
 * contexto ya resuelto: no leen cookies ni cabeceras, lo que los hace
 * reutilizables desde acciones, rutas API, tareas programadas y tests.
 * (La resolución a partir de la sesión está en ./sesion.ts.)
 */
export type ContextoUsuario = {
  usuarioId: number;
  /** Cuenta SaaS (tenant). Toda consulta fiscal se filtra por ella. */
  teamId: number;
  /** Rol dentro de la cuenta: 'owner' | 'member'. */
  rol: string;
  ip?: string | null;
};

/** Las operaciones que alteran la configuración fiscal exigen ser propietario. */
export function exigirPropietario(ctx: ContextoUsuario): void {
  if (ctx.rol !== 'owner') {
    throw new ErrorDominio(
      'SIN_PERMISO',
      'Solo el propietario de la cuenta puede realizar esta operación'
    );
  }
}
