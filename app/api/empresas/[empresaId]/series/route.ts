import { respuestaError } from '@/lib/verifactu/http';
import { siguienteNumeroPrevisto, TIPOS_FACTURA_POR_SERIE } from '@/lib/verifactu/series/reglas';
import { listarSeries } from '@/lib/verifactu/series/servicio';
import { obtenerContexto } from '@/lib/verifactu/sesion';

/**
 * GET /api/empresas/:empresaId/series[?tipo=ORDINARIA|SIMPLIFICADA|RECTIFICATIVA][&inactivas=1]
 * Devuelve cada serie con los tipos de factura que admite y el número que
 * tocaría a continuación (informativo: el real lo asigna la BD al emitir).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ empresaId: string }> }
) {
  try {
    const [ctx, { empresaId }] = await Promise.all([obtenerContexto(), params]);
    const query = new URL(request.url).searchParams;

    const series = await listarSeries(ctx, empresaId, {
      tipoSerie: query.get('tipo') ?? undefined,
      incluirInactivas: query.get('inactivas') === '1',
    });

    return Response.json(
      series.map((serie) => ({
        ...serie,
        tiposFacturaAdmitidos: TIPOS_FACTURA_POR_SERIE[serie.tipoSerie],
        siguienteNumeroPrevisto: siguienteNumeroPrevisto(serie),
      }))
    );
  } catch (error) {
    return respuestaError('GET /api/empresas/:empresaId/series', error);
  }
}
