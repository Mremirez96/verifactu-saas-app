import { estadoRemision, reintentarRemision } from '@/lib/verifactu/aeat/remision';
import { respuestaError } from '@/lib/verifactu/http';
import { obtenerContexto } from '@/lib/verifactu/sesion';

type Parametros = { params: Promise<{ empresaId: string }> };

/**
 * GET /api/empresas/:empresaId/remision → estado de la remisión a la AEAT:
 * registros pendientes, incidencia abierta y el AVISO que la interfaz debe
 * mostrar mientras queden registros sin remitir (art. 16.4 de la Orden).
 */
export async function GET(_request: Request, { params }: Parametros) {
  try {
    const [ctx, { empresaId }] = await Promise.all([obtenerContexto(), params]);
    return Response.json(await estadoRemision(ctx, empresaId));
  } catch (error) {
    return respuestaError('GET /api/empresas/:empresaId/remision', error);
  }
}

/**
 * POST /api/empresas/:empresaId/remision → «Reintentar ahora». El intento
 * sigue sujeto al control de flujo: puede responder `EN_ESPERA`.
 */
export async function POST(_request: Request, { params }: Parametros) {
  try {
    const [ctx, { empresaId }] = await Promise.all([obtenerContexto(), params]);
    return Response.json(await reintentarRemision(ctx, empresaId));
  } catch (error) {
    return respuestaError('POST /api/empresas/:empresaId/remision', error);
  }
}
