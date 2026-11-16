import { generarDocumentoFactura } from '@/lib/verifactu/documentos/servicio';
import { respuestaError } from '@/lib/verifactu/http';
import { obtenerContexto } from '@/lib/verifactu/sesion';

/**
 * GET /api/empresas/:empresaId/facturas/:facturaId/documento[?formato=a4|ticket|ticket58][&descargar=1]
 *
 * Devuelve la factura o el ticket como documento HTML listo para ver en el
 * móvil, imprimir o guardar como PDF.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ empresaId: string; facturaId: string }> }
) {
  try {
    const [ctx, { empresaId, facturaId }] = await Promise.all([obtenerContexto(), params]);
    const query = new URL(request.url).searchParams;

    const documento = await generarDocumentoFactura(ctx, empresaId, facturaId, {
      formato: query.get('formato'),
    });

    return new Response(documento.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `${query.get('descargar') === '1' ? 'attachment' : 'inline'}; filename="${documento.nombreArchivo}"`,
        // Datos fiscales y personales: ni cachés compartidas ni indexación.
        'Cache-Control': 'private, no-store',
        'X-Robots-Tag': 'noindex',
        // El documento no lleva scripts ni recursos externos; la política lo garantiza
        // aunque algún dato de la factura intentara colar marcado.
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return respuestaError('GET /api/empresas/:empresaId/facturas/:facturaId/documento', error);
  }
}
