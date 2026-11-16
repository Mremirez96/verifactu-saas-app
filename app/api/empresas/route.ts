import { listarEmpresas } from '@/lib/verifactu/empresas/servicio';
import { respuestaError } from '@/lib/verifactu/http';
import { obtenerContexto } from '@/lib/verifactu/sesion';

/** GET /api/empresas → empresas de la cuenta del usuario (para SWR). */
export async function GET() {
  try {
    const ctx = await obtenerContexto();
    return Response.json(await listarEmpresas(ctx));
  } catch (error) {
    return respuestaError('GET /api/empresas', error);
  }
}
