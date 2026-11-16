import { db } from '@/lib/db/drizzle';
import type { ContextoUsuario } from '../contexto';
import { cargarEmpresa } from '../empresas/servicio';
import { ErrorDominio } from '../errores';
import { uuid, validar } from '../validacion';
import type { FormatoDocumento } from './modelo';
import { renderizarDocumento, type DocumentoGenerado } from './renderizado';
import { cargarDatosDocumento } from './repositorio';

/**
 * SERVICIO DE REPRESENTACIÓN DE FACTURAS
 *
 * Carga la factura (comprobando que es de la cuenta del usuario) y delega en
 * `renderizarDocumento`. El documento NO se guarda: se regenera cada vez a
 * partir de datos inalterables (factura emitida y registro de alta), así que
 * siempre sale el mismo.
 *
 *   · Emitida o anulada → con su QR (el del registro de alta) y, en su caso, el aviso de anulación.
 *   · Borrador          → previsualización marcada como tal y SIN QR.
 */
export async function generarDocumentoFactura(
  ctx: ContextoUsuario,
  empresaId: unknown,
  facturaId: unknown,
  opciones: { formato?: unknown } = {}
): Promise<DocumentoGenerado> {
  const idFactura = validar(uuid('factura'), facturaId);
  const formato = resolverFormato(opciones.formato);

  const empresa = await cargarEmpresa(ctx, empresaId);
  const datos = await cargarDatosDocumento(db, empresa.id, idFactura);
  if (!datos) {
    throw new ErrorDominio('NO_ENCONTRADO', 'Factura no encontrada');
  }
  return renderizarDocumento(datos, formato);
}

/** Acepta 'A4', 'TICKET_80', 'TICKET_58' y los atajos 'a4', 'ticket', 'ticket58'. */
function resolverFormato(valor: unknown): FormatoDocumento | undefined {
  if (valor === undefined || valor === null || valor === '') return undefined;
  const texto = String(valor).toUpperCase().replace(/[^A-Z0-9]/g, '');
  const formatos: Record<string, FormatoDocumento> = {
    A4: 'A4',
    TICKET: 'TICKET_80',
    TICKET80: 'TICKET_80',
    TICKET58: 'TICKET_58',
  };
  if (!formatos[texto]) {
    throw new ErrorDominio('VALIDACION', 'Formato de documento no válido (a4, ticket o ticket58)');
  }
  return formatos[texto];
}
