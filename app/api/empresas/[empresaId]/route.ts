import { obtenerEmpresa } from '@/lib/verifactu/empresas/servicio';
import { respuestaError } from '@/lib/verifactu/http';
import { obtenerContexto } from '@/lib/verifactu/sesion';

/** GET /api/empresas/:empresaId → empresa + estado de sus cadenas + series. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ empresaId: string }> }
) {
  try {
    const [ctx, { empresaId }] = await Promise.all([obtenerContexto(), params]);
    return Response.json(await obtenerEmpresa(ctx, empresaId));
  } catch (error) {
    return respuestaError('GET /api/empresas/:empresaId', error);
  }
}
