import { randomUUID } from 'node:crypto';
import { db, type DbOrTx } from '@/lib/db/drizzle';
import {
  ActivityType,
  type CadenaFiscal,
  type Empresa,
  type SerieFacturacion,
} from '@/lib/db/schema';
import { registrarActividad } from '../actividad';
import { exigirPropietario, type ContextoUsuario } from '../contexto';
import { ErrorDominio, traducirErrorBd } from '../errores';
import { insertarSeries, listarSeriesDeEmpresa } from '../series/repositorio';
import { uuid, validar } from '../validacion';
import {
  buscarEmpresaDeEquipo,
  insertarEmpresa,
  leerCadenas,
  listarEmpresasDeEquipo,
} from './repositorio';
import { altaEmpresaSchema } from './validacion';

/* -------------------------------------------------------------------------- */
/*  Configuración inicial de una empresa                                      */
/* -------------------------------------------------------------------------- */

/**
 * Series con las que nace toda empresa, una por tipo y marcada por defecto.
 * El código lleva el año (F26-, T26-, R26-): el reinicio anual de la
 * numeración se hace creando series nuevas, nunca tocando el contador.
 */
export const SERIES_INICIALES = [
  { tipoSerie: 'ORDINARIA', prefijo: 'F', descripcion: 'Facturas' },
  { tipoSerie: 'SIMPLIFICADA', prefijo: 'T', descripcion: 'Facturas simplificadas (tickets)' },
  // Las rectificativas exigen serie específica (art. 6.1.a RD 1619/2012).
  { tipoSerie: 'RECTIFICATIVA', prefijo: 'R', descripcion: 'Facturas rectificativas' },
] as const;

const VALORES_POR_IMPUESTO = {
  '01': { tipo: '21.00', huso: 'Europe/Madrid' }, // IVA, tipo general
  '02': { tipo: undefined, huso: 'Europe/Madrid' }, // IPSI: el tipo lo indica el usuario
  '03': { tipo: '7.00', huso: 'Atlantic/Canary' }, // IGIC, tipo general
} as const;

/** Año en curso en el huso de la empresa (a las 23:30 del 31-dic en Canarias sigue siendo el año viejo). */
function ejercicioActual(husoHorario: string): number {
  return Number(
    new Intl.DateTimeFormat('en-CA', { timeZone: husoHorario, year: 'numeric' }).format(new Date())
  );
}

/* -------------------------------------------------------------------------- */
/*  Alta de empresa                                                           */
/* -------------------------------------------------------------------------- */

export type AltaEmpresaResultado = {
  empresa: Empresa;
  cadenas: CadenaFiscal[];
  series: SerieFacturacion[];
};

/**
 * Da de alta una empresa (obligado tributario) en la cuenta del usuario.
 *
 * Todo ocurre en UNA transacción; si cualquier comprobación falla no queda
 * rastro de la empresa:
 *   1. Inserta la empresa. Un trigger crea sus dos cadenas fiscales.
 *   2. VERIFICA que las cadenas existen y están vacías (sin último registro,
 *      secuencia 0). Una empresa sin cadena no podría facturar; una empresa
 *      con una cadena "empezada" tendría la trazabilidad rota desde el inicio.
 *   3. Crea las series por defecto y VERIFICA que sus contadores están a 0.
 *   4. Anota la actividad.
 */
export async function altaEmpresa(
  ctx: ContextoUsuario,
  entrada: unknown
): Promise<AltaEmpresaResultado> {
  exigirPropietario(ctx);
  const datos = validar(altaEmpresaSchema, entrada);

  // El modo NO VERI*FACTU obliga a registrar, encadenado y firmado, el evento
  // «Inicio del funcionamiento del sistema como NO VERI*FACTU» (art. 9.1.a de
  // la Orden HAC/1177/2024). Hasta que exista el motor de huellas y firma
  // (siguiente paso) no se puede generar ese evento, así que el alta en ese
  // modo se rechaza en lugar de crear empresas que nacerían incumpliendo.
  // TODO(fase-2): retirar esta guarda y emitir el evento 01 dentro del alta.
  if (datos.modoVerifactu === 'NO_VERIFACTU') {
    throw new ErrorDominio(
      'VALIDACION',
      'El modo NO VERI*FACTU todavía no está disponible: requiere el registro de eventos firmado'
    );
  }

  const porImpuesto = VALORES_POR_IMPUESTO[datos.impuestoPorDefecto];
  const husoHorario = datos.husoHorario ?? porImpuesto.huso;

  try {
    return await db.transaction(async (tx) => {
      const empresa = await insertarEmpresa(tx, {
        teamId: ctx.teamId,
        nif: datos.nif,
        nombreRazon: datos.nombreRazon,
        nombreComercial: datos.nombreComercial,
        direccion: datos.direccion,
        codigoPostal: datos.codigoPostal,
        municipio: datos.municipio,
        provincia: datos.provincia,
        email: datos.email,
        telefono: datos.telefono,
        modoVerifactu: datos.modoVerifactu,
        // «NumeroInstalacion»: identifica esta instalación lógica del SIF para
        // este obligado. Único e inmutable (lo protege un trigger).
        numeroInstalacion: `VF-${randomUUID().toUpperCase()}`,
        husoHorario,
        impuestoPorDefecto: datos.impuestoPorDefecto,
        // `porImpuesto.tipo` solo es undefined para IPSI, y ahí la validación
        // ya ha exigido que el usuario lo indique.
        tipoImpositivoPorDefecto: datos.tipoImpositivoPorDefecto ?? porImpuesto.tipo,
        retencionIrpfPorDefecto: datos.retencionIrpfPorDefecto,
      });

      const cadenas = await leerCadenas(tx, empresa.id);
      verificarCadenasIniciales(empresa, cadenas);

      const ejercicio = ejercicioActual(husoHorario);
      const sufijo = String(ejercicio).slice(-2);
      const series = await insertarSeries(
        tx,
        SERIES_INICIALES.map((s) => ({
          empresaId: empresa.id,
          codigo: `${s.prefijo}${sufijo}-`,
          descripcion: s.descripcion,
          tipoSerie: s.tipoSerie,
          ejercicio,
          porDefecto: true,
        }))
      );
      verificarSeriesIniciales(empresa, series);

      await registrarActividad(tx, ctx, ActivityType.CREATE_EMPRESA, empresa.nif);

      return { empresa, cadenas, series };
    });
  } catch (error) {
    traducirErrorBd(error, {
      // No se dice en qué cuenta está: sería filtrar información entre tenants.
      empresas_nif_uq: 'Ya existe una empresa registrada con ese NIF',
      empresas_nif_formato_ck: 'El NIF no tiene un formato válido',
    });
  }
}

/** Las dos cadenas (facturación y eventos) existen y están sin estrenar. */
function verificarCadenasIniciales(empresa: Empresa, cadenas: CadenaFiscal[]): void {
  const tipos = cadenas.map((c) => c.tipoCadena).sort();
  const completas = tipos.length === 2 && tipos[0] === 'EVENTOS' && tipos[1] === 'FACTURACION';
  const vacias = cadenas.every(
    (c) =>
      c.ultimoId === null &&
      c.ultimaHuella === null &&
      c.ultimoNumSecuencia === 0 &&
      c.ultimaGeneracion === null
  );

  if (!completas || !vacias) {
    throw new ErrorDominio(
      'INTEGRIDAD',
      'Las cadenas fiscales de la empresa no se han inicializado correctamente',
      { empresaId: empresa.id, cadenas }
    );
  }
}

/** Una serie por defecto de cada tipo, todas con el contador a cero. */
function verificarSeriesIniciales(empresa: Empresa, series: SerieFacturacion[]): void {
  const correcto =
    series.length === SERIES_INICIALES.length &&
    SERIES_INICIALES.every(
      (inicial) =>
        series.filter(
          (s) =>
            s.tipoSerie === inicial.tipoSerie &&
            s.empresaId === empresa.id &&
            s.porDefecto &&
            s.activa &&
            s.ultimoNumero === 0 &&
            s.ultimaFechaExpedicion === null
        ).length === 1
    );

  if (!correcto) {
    throw new ErrorDominio(
      'INTEGRIDAD',
      'Las series por defecto de la empresa no se han inicializado correctamente',
      { empresaId: empresa.id, series }
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Consulta                                                                  */
/* -------------------------------------------------------------------------- */

export async function listarEmpresas(ctx: ContextoUsuario): Promise<Empresa[]> {
  return listarEmpresasDeEquipo(db, ctx.teamId);
}

/**
 * Carga una empresa comprobando que es de la cuenta del usuario. Es LA puerta
 * de entrada de cualquier operación sobre datos fiscales: si la empresa no
 * existe o es de otra cuenta, la respuesta es la misma («no encontrada»).
 */
export async function cargarEmpresa(
  ctx: ContextoUsuario,
  empresaId: unknown,
  dbx: DbOrTx = db,
  opciones: { bloquear?: boolean } = {}
): Promise<Empresa> {
  const id = validar(uuid('empresa'), empresaId);
  const empresa = await buscarEmpresaDeEquipo(dbx, ctx.teamId, id, opciones);
  if (!empresa) {
    throw new ErrorDominio('NO_ENCONTRADO', 'Empresa no encontrada');
  }
  return empresa;
}

export type EmpresaDetalle = AltaEmpresaResultado;

/** Empresa con el estado de sus cadenas y sus series. */
export async function obtenerEmpresa(
  ctx: ContextoUsuario,
  empresaId: unknown
): Promise<EmpresaDetalle> {
  const empresa = await cargarEmpresa(ctx, empresaId);
  const [cadenas, series] = await Promise.all([
    leerCadenas(db, empresa.id),
    listarSeriesDeEmpresa(db, empresa.id, { incluirInactivas: true }),
  ]);
  return { empresa, cadenas, series };
}
