'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { ActionState } from '@/lib/auth/middleware';
import type { ContextoUsuario } from '@/lib/verifactu/contexto';
import { altaEmpresa } from '@/lib/verifactu/empresas/servicio';
import { ErrorDominio } from '@/lib/verifactu/errores';
import { mensajeParaUsuario } from '@/lib/verifactu/http';
import {
  crearSerie,
  eliminarSerie,
  marcarSeriePorDefecto,
  modificarSerie,
} from '@/lib/verifactu/series/servicio';
import { obtenerContexto } from '@/lib/verifactu/sesion';

/**
 * Acciones de servidor de Empresas y Series (capa «controlador»).
 *
 * No contienen lógica de negocio: resuelven quién llama, delegan en el
 * servicio y traducen el resultado al `ActionState` del starter, que es lo
 * que consume `useActionState` en los formularios:
 *
 *   const [estado, accion, pendiente] = useActionState(crearEmpresaAction, {});
 *   <form action={accion}> ... {estado.error} {estado.success}
 */

const RUTA = '/dashboard/empresas';

async function ejecutar<T>(
  operacion: string,
  trabajo: (ctx: ContextoUsuario) => Promise<T>,
  exito: (resultado: T) => ActionState
): Promise<ActionState> {
  let estado: ActionState;
  try {
    const ctx = await obtenerContexto();
    estado = exito(await trabajo(ctx));
  } catch (error) {
    if (error instanceof ErrorDominio && error.codigo === 'NO_AUTENTICADO') {
      redirect('/sign-in');
    }
    return { error: mensajeParaUsuario(operacion, error) };
  }
  revalidatePath(RUTA, 'layout');
  return estado;
}

/** Convierte el formulario en un objeto plano; la validación es del servicio. */
const campos = (formData: FormData) => Object.fromEntries(formData);

/* ------------------------------ Empresas ---------------------------------- */

export async function crearEmpresaAction(
  _estadoPrevio: ActionState,
  formData: FormData
): Promise<ActionState> {
  return ejecutar(
    'crearEmpresa',
    (ctx) => altaEmpresa(ctx, campos(formData)),
    ({ empresa, series }) => ({
      success: `Empresa ${empresa.nombreRazon} dada de alta con ${series.length} series`,
      empresaId: empresa.id,
    })
  );
}

/* ------------------------------- Series ----------------------------------- */

export async function crearSerieAction(
  _estadoPrevio: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { empresaId, ...datos } = campos(formData);
  return ejecutar(
    'crearSerie',
    (ctx) => crearSerie(ctx, empresaId, datos),
    (serie) => ({ success: `Serie ${serie.codigo} creada`, serieId: serie.id })
  );
}

export async function modificarSerieAction(
  _estadoPrevio: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { empresaId, serieId, ...datos } = campos(formData);
  return ejecutar(
    'modificarSerie',
    (ctx) => modificarSerie(ctx, empresaId, serieId, datos),
    (serie) => ({ success: `Serie ${serie.codigo} actualizada`, serieId: serie.id })
  );
}

export async function marcarSeriePorDefectoAction(
  _estadoPrevio: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { empresaId, serieId } = campos(formData);
  return ejecutar(
    'marcarSeriePorDefecto',
    (ctx) => marcarSeriePorDefecto(ctx, empresaId, serieId),
    (serie) => ({ success: `La serie ${serie.codigo} es ahora la predeterminada`, serieId: serie.id })
  );
}

export async function eliminarSerieAction(
  _estadoPrevio: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { empresaId, serieId } = campos(formData);
  return ejecutar(
    'eliminarSerie',
    (ctx) => eliminarSerie(ctx, empresaId, serieId),
    () => ({ success: 'Serie eliminada' })
  );
}
