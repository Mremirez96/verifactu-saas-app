import { timingSafeEqual } from 'node:crypto';
import { procesarCola } from '@/lib/verifactu/aeat/remision';
import { registrarError } from '@/lib/verifactu/errores';

/**
 * GET|POST /api/cron/aeat → una pasada del worker de remisión a la AEAT.
 *
 * La llama una tarea programada, idealmente CADA MINUTO (el «t» inicial del
 * control de flujo es de 60 s, y la Orden exige reintentar al menos cada hora
 * mientras queden registros por remitir). No lleva sesión de usuario: se
 * autentica con un secreto compartido,
 *
 *     Authorization: Bearer <CRON_SECRET>
 *
 * que es la convención de Vercel Cron y sirve igual para cualquier planificador.
 * Sin CRON_SECRET configurado la ruta responde 503: nunca queda abierta.
 */
export const dynamic = 'force-dynamic';
// La pasada puede encadenar varios envíos; cada uno espera a la AEAT hasta el timeout.
export const maxDuration = 300;

function autorizado(request: Request): boolean | null {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return null;
  const recibido = Buffer.from(request.headers.get('authorization') ?? '');
  const esperado = Buffer.from(`Bearer ${secreto}`);
  // Comparación en tiempo constante: no revela cuántos caracteres coinciden.
  return recibido.length === esperado.length && timingSafeEqual(recibido, esperado);
}

async function ejecutar(request: Request): Promise<Response> {
  const permiso = autorizado(request);
  if (permiso === null) {
    return Response.json({ error: 'CRON_SECRET no está configurado' }, { status: 503 });
  }
  if (!permiso) {
    return Response.json({ error: 'No autorizado' }, { status: 401 });
  }
  try {
    return Response.json(await procesarCola());
  } catch (error) {
    registrarError('GET /api/cron/aeat', error);
    return Response.json({ error: 'La pasada de remisión ha fallado' }, { status: 500 });
  }
}

export const GET = ejecutar;
export const POST = ejecutar;
