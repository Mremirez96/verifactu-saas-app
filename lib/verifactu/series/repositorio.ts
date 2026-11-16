import { and, asc, eq, ne } from 'drizzle-orm';
import type { DbOrTx } from '@/lib/db/drizzle';
import {
  seriesFacturacion,
  type NewSerieFacturacion,
  type SerieFacturacion,
} from '@/lib/db/schema';

/**
 * Acceso a datos de series de facturación. Sin reglas de negocio.
 *
 * Nota: aquí NUNCA se escribe `ultimo_numero` ni `ultima_fecha_expedicion`.
 * El contador lo avanza el trigger de emisión de facturas; el rol de la
 * aplicación ni siquiera tiene permiso de UPDATE sobre esas dos columnas.
 */

type TipoSerie = SerieFacturacion['tipoSerie'];

/** Columnas que la aplicación puede modificar en una serie. */
export type CambiosSerie = Partial<
  Pick<
    NewSerieFacturacion,
    'codigo' | 'descripcion' | 'ejercicio' | 'digitosRelleno' | 'porDefecto' | 'activa'
  >
>;

export async function insertarSeries(
  dbx: DbOrTx,
  valores: NewSerieFacturacion[]
): Promise<SerieFacturacion[]> {
  return dbx.insert(seriesFacturacion).values(valores).returning();
}

export async function listarSeriesDeEmpresa(
  dbx: DbOrTx,
  empresaId: string,
  opciones: { incluirInactivas?: boolean; tipoSerie?: TipoSerie } = {}
): Promise<SerieFacturacion[]> {
  return dbx
    .select()
    .from(seriesFacturacion)
    .where(
      and(
        eq(seriesFacturacion.empresaId, empresaId),
        opciones.incluirInactivas ? undefined : eq(seriesFacturacion.activa, true),
        opciones.tipoSerie ? eq(seriesFacturacion.tipoSerie, opciones.tipoSerie) : undefined
      )
    )
    .orderBy(asc(seriesFacturacion.tipoSerie), asc(seriesFacturacion.codigo));
}

/** La serie se busca SIEMPRE junto a su empresa: no hay acceso solo por id. */
export async function buscarSerie(
  dbx: DbOrTx,
  empresaId: string,
  serieId: string
): Promise<SerieFacturacion | undefined> {
  const [serie] = await dbx
    .select()
    .from(seriesFacturacion)
    .where(and(eq(seriesFacturacion.empresaId, empresaId), eq(seriesFacturacion.id, serieId)))
    .limit(1);
  return serie;
}

export async function actualizarSerie(
  dbx: DbOrTx,
  empresaId: string,
  serieId: string,
  cambios: CambiosSerie
): Promise<SerieFacturacion> {
  const [serie] = await dbx
    .update(seriesFacturacion)
    .set(cambios)
    .where(and(eq(seriesFacturacion.empresaId, empresaId), eq(seriesFacturacion.id, serieId)))
    .returning();
  return serie;
}

/** Quita la marca «por defecto» a las demás series de ese tipo. */
export async function quitarPorDefecto(
  dbx: DbOrTx,
  empresaId: string,
  tipoSerie: TipoSerie,
  exceptoSerieId?: string
): Promise<void> {
  await dbx
    .update(seriesFacturacion)
    .set({ porDefecto: false })
    .where(
      and(
        eq(seriesFacturacion.empresaId, empresaId),
        eq(seriesFacturacion.tipoSerie, tipoSerie),
        eq(seriesFacturacion.porDefecto, true),
        exceptoSerieId ? ne(seriesFacturacion.id, exceptoSerieId) : undefined
      )
    );
}

export async function borrarSerie(dbx: DbOrTx, empresaId: string, serieId: string): Promise<void> {
  await dbx
    .delete(seriesFacturacion)
    .where(and(eq(seriesFacturacion.empresaId, empresaId), eq(seriesFacturacion.id, serieId)));
}
