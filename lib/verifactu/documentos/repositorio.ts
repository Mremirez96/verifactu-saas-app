import { and, asc, eq } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db/drizzle';
import { facturas, facturasDesglose, facturasLineas, registrosVerifactu } from '@/lib/db/schema';
import type { DatosDocumento } from './modelo';

/**
 * Lee todo lo necesario para representar una factura. Como siempre, la
 * factura se busca junto a su empresa: no hay acceso solo por identificador.
 */
export async function cargarDatosDocumento(
  dbx: DbOrTx,
  empresaId: string,
  facturaId: string
): Promise<DatosDocumento | undefined> {
  const [factura] = await dbx
    .select()
    .from(facturas)
    .where(and(eq(facturas.empresaId, empresaId), eq(facturas.id, facturaId)))
    .limit(1);
  if (!factura) return undefined;

  const [lineas, desglose, [registroAlta]] = await Promise.all([
    dbx.select().from(facturasLineas).where(eq(facturasLineas.facturaId, factura.id)).orderBy(asc(facturasLineas.orden)),
    dbx.select().from(facturasDesglose).where(eq(facturasDesglose.facturaId, factura.id)),
    // El alta inicial (no las subsanaciones): es la que acompañó a la expedición.
    dbx
      .select()
      .from(registrosVerifactu)
      .where(
        and(
          eq(registrosVerifactu.empresaId, empresaId),
          eq(registrosVerifactu.facturaId, factura.id),
          eq(registrosVerifactu.tipoRegistro, 'ALTA'),
          eq(registrosVerifactu.esSubsanacion, false)
        )
      )
      .limit(1),
  ]);

  return { factura, lineas, desglose, registroAlta: registroAlta ?? null };
}
