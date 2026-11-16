import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db/drizzle';
import {
  cadenasFiscales,
  empresas,
  type CadenaFiscal,
  type Empresa,
  type NewEmpresa,
} from '@/lib/db/schema';

/**
 * Acceso a datos de empresas. Sin reglas de negocio: solo SQL.
 * Todas las lecturas se filtran por `teamId`: una cuenta jamás ve ni toca
 * empresas de otra.
 */

export async function insertarEmpresa(dbx: DbOrTx, valores: NewEmpresa): Promise<Empresa> {
  const [empresa] = await dbx.insert(empresas).values(valores).returning();
  return empresa;
}

export async function listarEmpresasDeEquipo(dbx: DbOrTx, teamId: number): Promise<Empresa[]> {
  return dbx
    .select()
    .from(empresas)
    .where(eq(empresas.teamId, teamId))
    .orderBy(asc(empresas.nombreRazon));
}

/**
 * Devuelve la empresa solo si pertenece a la cuenta indicada.
 * Con `bloquear`, toma un FOR UPDATE sobre la fila: sirve de cerrojo para
 * serializar los cambios de configuración de una misma empresa.
 */
export async function buscarEmpresaDeEquipo(
  dbx: DbOrTx,
  teamId: number,
  empresaId: string,
  opciones: { bloquear?: boolean } = {}
): Promise<Empresa | undefined> {
  const consulta = dbx
    .select()
    .from(empresas)
    .where(and(eq(empresas.id, empresaId), eq(empresas.teamId, teamId)))
    .limit(1);

  const [empresa] = opciones.bloquear ? await consulta.for('update') : await consulta;
  return empresa;
}

/** Cabeceras de las cadenas fiscales de una empresa (solo lectura para la app). */
export async function leerCadenas(dbx: DbOrTx, empresaId: string): Promise<CadenaFiscal[]> {
  return dbx
    .select()
    .from(cadenasFiscales)
    .where(eq(cadenasFiscales.empresaId, empresaId))
    .orderBy(asc(cadenasFiscales.tipoCadena));
}
