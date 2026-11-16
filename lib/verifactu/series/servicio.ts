import { db, type DbOrTx } from '@/lib/db/drizzle';
import { ActivityType, type SerieFacturacion } from '@/lib/db/schema';
import { registrarActividad } from '../actividad';
import { exigirPropietario, type ContextoUsuario } from '../contexto';
import { cargarEmpresa } from '../empresas/servicio';
import { ErrorDominio, traducirErrorBd } from '../errores';
import { uuid, validar } from '../validacion';
import {
  actualizarSerie,
  borrarSerie,
  buscarSerie,
  insertarSeries,
  listarSeriesDeEmpresa,
  quitarPorDefecto,
  type CambiosSerie,
} from './repositorio';
import { altaSerieSchema, cambiosSerieSchema, TIPOS_SERIE } from './validacion';

type TipoSerie = SerieFacturacion['tipoSerie'];

/** Mensajes para las restricciones de la tabla que el usuario puede provocar. */
const RESTRICCIONES = {
  series_empresa_codigo_uq: 'Ya existe una serie con ese código en esta empresa',
  series_por_defecto_uq: 'Otra operación ha cambiado la serie por defecto; inténtelo de nuevo',
  series_codigo_formato_ck: 'El código solo admite letras, números y los signos / _ . -',
  series_digitos_ck: 'El número de dígitos debe estar entre 1 y 12',
  facturas_serie_fk: 'La serie tiene facturas (aunque sean borradores) y no se puede borrar',
};

/**
 * Carga la serie de una empresa de la cuenta del usuario, o falla con
 * «no encontrada». `dbx` permite hacerlo dentro de una transacción.
 */
async function cargarSerie(
  dbx: DbOrTx,
  empresaId: string,
  serieId: unknown
): Promise<SerieFacturacion> {
  const id = validar(uuid('serie'), serieId);
  const serie = await buscarSerie(dbx, empresaId, id);
  if (!serie) {
    throw new ErrorDominio('NO_ENCONTRADO', 'Serie no encontrada');
  }
  return serie;
}

/* -------------------------------------------------------------------------- */
/*  Consulta                                                                  */
/* -------------------------------------------------------------------------- */

export async function listarSeries(
  ctx: ContextoUsuario,
  empresaId: unknown,
  opciones: { incluirInactivas?: boolean; tipoSerie?: unknown } = {}
): Promise<SerieFacturacion[]> {
  const empresa = await cargarEmpresa(ctx, empresaId);
  const tipoSerie = TIPOS_SERIE.find((t) => t === opciones.tipoSerie);
  return listarSeriesDeEmpresa(db, empresa.id, {
    incluirInactivas: opciones.incluirInactivas,
    tipoSerie,
  });
}

/* -------------------------------------------------------------------------- */
/*  Alta                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Crea una serie de facturación. El tipo (ordinaria, simplificada o
 * rectificativa) se fija aquí y ya no cambia.
 *
 * El contador nace en 0 siempre: aunque alguien enviara otro valor, un
 * trigger lo pone a cero y la app no tiene permiso para modificarlo después.
 */
export async function crearSerie(
  ctx: ContextoUsuario,
  empresaId: unknown,
  entrada: unknown
): Promise<SerieFacturacion> {
  exigirPropietario(ctx);
  const datos = validar(altaSerieSchema, entrada);

  try {
    return await db.transaction(async (tx) => {
      // El FOR UPDATE sobre la empresa serializa los cambios de configuración:
      // dos altas simultáneas «por defecto» no pueden pisarse.
      const empresa = await cargarEmpresa(ctx, empresaId, tx, { bloquear: true });

      if (datos.porDefecto) {
        await quitarPorDefecto(tx, empresa.id, datos.tipoSerie);
      }

      const [serie] = await insertarSeries(tx, [
        {
          empresaId: empresa.id,
          codigo: datos.codigo,
          tipoSerie: datos.tipoSerie,
          descripcion: datos.descripcion,
          ejercicio: datos.ejercicio,
          digitosRelleno: datos.digitosRelleno,
          porDefecto: datos.porDefecto,
        },
      ]);

      if (serie.ultimoNumero !== 0 || serie.ultimaFechaExpedicion !== null) {
        throw new ErrorDominio('INTEGRIDAD', 'La serie no ha nacido con el contador a cero', {
          serieId: serie.id,
        });
      }

      await registrarActividad(tx, ctx, ActivityType.CREATE_SERIE, `${empresa.nif} ${serie.codigo}`);
      return serie;
    });
  } catch (error) {
    traducirErrorBd(error, RESTRICCIONES);
  }
}

/* -------------------------------------------------------------------------- */
/*  Modificación                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Modifica una serie.
 *   · Descripción, ejercicio y activa/inactiva: siempre.
 *   · Código y número de dígitos: solo mientras la serie no haya emitido
 *     ninguna factura. Después forman parte de números ya expedidos y son
 *     inalterables (lo comprueba aquí el servicio, para dar un mensaje claro,
 *     y lo garantiza un trigger en la base de datos).
 */
export async function modificarSerie(
  ctx: ContextoUsuario,
  empresaId: unknown,
  serieId: unknown,
  entrada: unknown
): Promise<SerieFacturacion> {
  exigirPropietario(ctx);
  const datos = validar(cambiosSerieSchema, entrada);

  try {
    return await db.transaction(async (tx) => {
      const empresa = await cargarEmpresa(ctx, empresaId, tx, { bloquear: true });
      const serie = await cargarSerie(tx, empresa.id, serieId);

      const cambiaFormato =
        (datos.codigo !== undefined && datos.codigo !== serie.codigo) ||
        (datos.digitosRelleno !== undefined && datos.digitosRelleno !== serie.digitosRelleno);

      if (cambiaFormato && serie.ultimoNumero > 0) {
        throw new ErrorDominio(
          'CONFLICTO',
          `La serie ${serie.codigo} ya ha emitido facturas: su código y formato no se pueden cambiar. Cree una serie nueva.`
        );
      }
      if (datos.activa === false && serie.porDefecto) {
        throw new ErrorDominio(
          'CONFLICTO',
          'No se puede desactivar la serie por defecto. Marque antes otra serie como predeterminada.'
        );
      }

      const cambios: CambiosSerie = {};
      if (datos.codigo !== undefined) cambios.codigo = datos.codigo;
      if (datos.descripcion !== undefined) cambios.descripcion = datos.descripcion || null;
      if (datos.ejercicio !== undefined) cambios.ejercicio = datos.ejercicio;
      if (datos.digitosRelleno !== undefined) cambios.digitosRelleno = datos.digitosRelleno;
      if (datos.activa !== undefined) cambios.activa = datos.activa;

      const actualizada = await actualizarSerie(tx, empresa.id, serie.id, cambios);
      await registrarActividad(tx, ctx, ActivityType.UPDATE_SERIE, `${empresa.nif} ${actualizada.codigo}`);
      return actualizada;
    });
  } catch (error) {
    traducirErrorBd(error, RESTRICCIONES);
  }
}

/**
 * Marca una serie como predeterminada para su tipo. Solo puede haber una por
 * empresa y tipo (índice único parcial), así que primero se desmarca la
 * anterior, todo en la misma transacción.
 */
export async function marcarSeriePorDefecto(
  ctx: ContextoUsuario,
  empresaId: unknown,
  serieId: unknown
): Promise<SerieFacturacion> {
  exigirPropietario(ctx);

  try {
    return await db.transaction(async (tx) => {
      const empresa = await cargarEmpresa(ctx, empresaId, tx, { bloquear: true });
      const serie = await cargarSerie(tx, empresa.id, serieId);

      if (!serie.activa) {
        throw new ErrorDominio('CONFLICTO', 'Una serie inactiva no puede ser la predeterminada');
      }
      if (serie.porDefecto) return serie;

      await quitarPorDefecto(tx, empresa.id, serie.tipoSerie, serie.id);
      const actualizada = await actualizarSerie(tx, empresa.id, serie.id, { porDefecto: true });
      await registrarActividad(tx, ctx, ActivityType.UPDATE_SERIE, `${empresa.nif} ${serie.codigo} por defecto`);
      return actualizada;
    });
  } catch (error) {
    traducirErrorBd(error, RESTRICCIONES);
  }
}

/* -------------------------------------------------------------------------- */
/*  Baja                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Borra una serie que NUNCA se ha usado. Una serie con facturas emitidas no
 * se borra jamás (trigger); lo correcto es desactivarla con `modificarSerie`.
 */
export async function eliminarSerie(
  ctx: ContextoUsuario,
  empresaId: unknown,
  serieId: unknown
): Promise<void> {
  exigirPropietario(ctx);

  try {
    await db.transaction(async (tx) => {
      const empresa = await cargarEmpresa(ctx, empresaId, tx, { bloquear: true });
      const serie = await cargarSerie(tx, empresa.id, serieId);

      if (serie.ultimoNumero > 0) {
        throw new ErrorDominio(
          'CONFLICTO',
          `La serie ${serie.codigo} ya ha emitido facturas y no se puede borrar; puede desactivarla.`
        );
      }
      if (serie.porDefecto) {
        throw new ErrorDominio(
          'CONFLICTO',
          'No se puede borrar la serie por defecto. Marque antes otra serie como predeterminada.'
        );
      }

      await borrarSerie(tx, empresa.id, serie.id);
      await registrarActividad(tx, ctx, ActivityType.DELETE_SERIE, `${empresa.nif} ${serie.codigo}`);
    });
  } catch (error) {
    traducirErrorBd(error, RESTRICCIONES);
  }
}

/* -------------------------------------------------------------------------- */
/*  Para el servicio de emisión (siguiente fase)                              */
/* -------------------------------------------------------------------------- */

/** Serie activa predeterminada de un tipo, o `undefined` si no hay ninguna. */
export async function seriePorDefecto(
  dbx: DbOrTx,
  empresaId: string,
  tipoSerie: TipoSerie
): Promise<SerieFacturacion | undefined> {
  const series = await listarSeriesDeEmpresa(dbx, empresaId, { tipoSerie });
  return series.find((s) => s.porDefecto);
}
