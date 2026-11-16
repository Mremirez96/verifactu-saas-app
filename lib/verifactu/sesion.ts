import { eq } from 'drizzle-orm';
import { headers } from 'next/headers';
import { db } from '@/lib/db/drizzle';
import { getUser } from '@/lib/db/queries';
import { teamMembers } from '@/lib/db/schema';
import type { ContextoUsuario } from './contexto';
import { ErrorDominio } from './errores';

/**
 * Construye el contexto de la petición a partir de la sesión (cookie JWT del
 * starter) y de la pertenencia del usuario a su cuenta.
 */
export async function obtenerContexto(): Promise<ContextoUsuario> {
  const usuario = await getUser();
  if (!usuario) {
    throw new ErrorDominio('NO_AUTENTICADO', 'Debe iniciar sesión');
  }

  const [miembro] = await db
    .select({ teamId: teamMembers.teamId, rol: teamMembers.role })
    .from(teamMembers)
    .where(eq(teamMembers.userId, usuario.id))
    .limit(1);

  if (!miembro) {
    throw new ErrorDominio('SIN_PERMISO', 'El usuario no pertenece a ninguna cuenta');
  }

  const cabeceras = await headers();
  const ip = cabeceras.get('x-forwarded-for')?.split(',')[0]?.trim() || null;

  return { usuarioId: usuario.id, teamId: miembro.teamId, rol: miembro.rol, ip };
}
