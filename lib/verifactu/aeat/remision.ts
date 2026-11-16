import { db } from '@/lib/db/drizzle';
import type { AeatControlFlujo, AeatLote, EnvioAeat } from '@/lib/db/schema';
import type { ContextoUsuario } from '../contexto';
import { sha256Hex } from '../crypto';
import { cargarEmpresa } from '../empresas/servicio';
import { ErrorDominio, registrarError } from '../errores';
import { configuracionAeat, type ConfiguracionAeat } from './config';
import { proximoEnvio, TIEMPO_ESPERA_INICIAL_SEG } from './reintentos';
import {
  actualizarControl,
  bloquearControl,
  cerrarEnvios,
  cerrarLote,
  contarSinRemitir,
  devolverACola,
  empresasConEnviosListos,
  horaBaseDatos,
  insertarLote,
  leerControl,
  leerEnCola,
  leerObligado,
  marcarEnviando,
  resumenEnvios,
  ultimosLotes,
  type EnvioEnCola,
} from './repositorio';
import {
  clasificarErrorDeEnvio,
  clasificarRespuestaHttp,
  desenlaceDeLinea,
  emparejarLineas,
  type DesenlaceEnvio,
  type DesenlaceRegistro,
} from './respuesta';
import { construirMensajeRemision, interpretarRespuesta, MAX_REGISTROS_POR_ENVIO, type LineaRespuesta } from './soap';
import { crearTransporteHttps, type Transporte } from './transporte';

/**
 * REMISIÓN VOLUNTARIA «VERI*FACTU»: COLA, ESTADOS Y REINTENTOS
 *
 * La cola es la tabla `envios_aeat` (una fila por registro, creada por un
 * trigger al nacer el registro). Este servicio la vacía empresa a empresa.
 *
 * CICLO DE UN ENVÍO (tres pasos; la red NUNCA queda dentro de una transacción)
 *
 *   1. RESERVA (transacción corta)
 *        · cerrojo de la empresa (`aeat_control_flujo`, SKIP LOCKED);
 *        · ¿toca enviar? control de flujo y espera de reintento;
 *        · se toman los primeros registros en cola, en orden de generación;
 *        · PENDIENTE/ERROR_TRANSITORIO → ENVIANDO, se crea el lote EN_CURSO y
 *          se anota un ARRENDAMIENTO con caducidad.
 *   2. ENVÍO (sin transacción): POST del sobre SOAP y espera de la respuesta.
 *   3. LIQUIDACIÓN (transacción corta)
 *        · cada registro pasa a su estado según la AEAT, o vuelve a la cola;
 *        · el lote se cierra con la respuesta íntegra (acuse con CSV);
 *        · se recalcula cuándo puede salir el siguiente mensaje.
 *
 * QUÉ PASA SI EL PROCESO MUERE ENTRE 2 Y 3. Los registros quedarían en
 * ENVIANDO para siempre. Por eso existe el arrendamiento: cuando caduca, el
 * siguiente worker devuelve esos registros a la cola marcados como «entrega
 * incierta» y los reenvía; si la AEAT ya los tenía, lo dirá («duplicado») y se
 * concilian (ver respuesta.ts). Ningún registro se pierde ni se duplica.
 *
 * ORDEN. Nunca hay dos mensajes de una misma empresa en vuelo, y cada mensaje
 * toma los registros más antiguos: si el primero de la cola no puede salir,
 * los posteriores esperan detrás (art. 16.4 de la Orden).
 */

export type DependenciasRemision = {
  /** Por defecto, HTTPS con el certificado de la configuración. */
  transporte?: Transporte;
  /** Por defecto, la configuración del entorno. */
  config?: ConfiguracionAeat;
  /** Por defecto, el reloj de la base de datos. */
  reloj?: () => Date | Promise<Date>;
  /** Fuente de azar para la dispersión de los reintentos. */
  aleatorio?: () => number;
};

export type EstadoRemision =
  | 'SIN_PENDIENTES' // nada en cola
  | 'EN_ESPERA' // hay registros, pero aún no toca (control de flujo o espera de reintento)
  | 'OCUPADA' // otro proceso está enviando los registros de esta empresa
  | 'ENVIADO' // la AEAT ha respondido registro a registro
  | 'FALLO_TRANSITORIO' // sin respuesta útil: se reintentará
  | 'ENVIO_RECHAZADO'; // la AEAT rechaza el mensaje completo: requiere intervención

export type ResultadoRemision = {
  empresaId: string;
  estado: EstadoRemision;
  loteId: string | null;
  /** Registros incluidos en el mensaje. */
  enviados: number;
  aceptados: number;
  aceptadosConErrores: number;
  rechazados: number;
  /** Registros que vuelven a la cola. */
  devueltosACola: number;
  /** Registros de la empresa que siguen sin remitir tras esta llamada. */
  pendientes: number;
  csv: string | null;
  proximoEnvioEn: Date | null;
  error: { codigo: string; mensaje: string } | null;
};

/* -------------------------------------------------------------------------- */
/*  Dependencias                                                              */
/* -------------------------------------------------------------------------- */

/** La configuración del entorno (y su certificado) se lee una sola vez por proceso. */
let configPorDefecto: ConfiguracionAeat | null = null;
/** Un transporte por configuración: el agente HTTPS, con el certificado cargado, se reutiliza. */
const transportes = new WeakMap<ConfiguracionAeat, Transporte>();

export function resolverDependencias(deps: DependenciasRemision) {
  const config = deps.config ?? (configPorDefecto ??= configuracionAeat());
  let transporte = deps.transporte ?? transportes.get(config);
  if (!transporte) {
    transporte = crearTransporteHttps(config.credenciales);
    transportes.set(config, transporte);
  }
  return {
    config,
    transporte,
    reloj: deps.reloj ?? (() => horaBaseDatos(db)),
    aleatorio: deps.aleatorio ?? Math.random,
  };
}

/** Margen sobre el timeout de red antes de dar por perdido un envío en vuelo. */
const MARGEN_ARRENDAMIENTO_MS = 60_000;

/* -------------------------------------------------------------------------- */
/*  Paso 1: reserva                                                           */
/* -------------------------------------------------------------------------- */

type Reserva =
  | { tipo: 'NADA'; estado: 'SIN_PENDIENTES' | 'EN_ESPERA' | 'OCUPADA'; pendientes: number; proximoEnvioEn: Date | null }
  | { tipo: 'LOTE'; lote: AeatLote; enviados: EnvioEnCola[]; xml: string; control: AeatControlFlujo };

async function reservar(
  empresaId: string,
  ahora: Date,
  config: ConfiguracionAeat,
  aleatorio: () => number
): Promise<Reserva> {
  return db.transaction(async (tx): Promise<Reserva> => {
    let control = await bloquearControl(tx, empresaId, { esperar: false });
    if (!control) {
      return { tipo: 'NADA', estado: 'OCUPADA', pendientes: 0, proximoEnvioEn: null };
    }

    // ¿Hay un mensaje en vuelo?
    if (control.loteEnCursoId && control.loteEnCursoCaducaEn) {
      if (control.loteEnCursoCaducaEn > ahora) {
        return { tipo: 'NADA', estado: 'OCUPADA', pendientes: 0, proximoEnvioEn: control.loteEnCursoCaducaEn };
      }
      // Arrendamiento caducado: el proceso que enviaba murió sin liquidar. Sus
      // registros vuelven a la cola; no se sabe si la AEAT llegó a recibirlos.
      const fallos = control.fallosConsecutivos + 1;
      const siguiente = proximoEnvio({
        ahora,
        ultimoEnvioEn: control.ultimoEnvioEn ?? ahora,
        tiempoEsperaSeg: control.tiempoEsperaSeg,
        fallosConsecutivos: fallos,
        aleatorio,
      });
      const mensaje = 'INTERRUMPIDO: el envío quedó sin liquidar (proceso interrumpido)';
      await devolverACola(tx, empresaId, {
        codigoError: 'INTERRUMP',
        descripcionError: mensaje,
        entregaIncierta: true,
        proximoIntentoEn: siguiente,
        ahora,
      });
      await cerrarLote(tx, control.loteEnCursoId, {
        resultado: 'ERROR_TRANSITORIO',
        finalizadoEn: ahora,
        codigoError: 'INTERRUMPIDO',
        descripcionError: mensaje,
      });
      const cambios = {
        loteEnCursoId: null,
        loteEnCursoCaducaEn: null,
        fallosConsecutivos: fallos,
        incidenciaDesde: control.incidenciaDesde ?? control.ultimoEnvioEn ?? ahora,
        ultimoErrorCodigo: 'INTERRUMPIDO',
        ultimoError: mensaje,
        proximoEnvioEn: siguiente,
      };
      await actualizarControl(tx, empresaId, cambios);
      control = { ...control, ...cambios };
    }

    // Tras un rechazo del envío completo se avanza de uno en uno: así los
    // registros sanos anteriores al problemático salen, y este queda aislado.
    const tamano = control.requiereIntervencion ? 1 : MAX_REGISTROS_POR_ENVIO;
    const enCola = await leerEnCola(tx, empresaId, tamano);
    if (enCola.length === 0) {
      return { tipo: 'NADA', estado: 'SIN_PENDIENTES', pendientes: 0, proximoEnvioEn: null };
    }

    // CONTROL DEL MODO: un registro generado en modo NO VERI*FACTU jamás sale
    // por la remisión voluntaria. La base de datos ya lo impide (nace NO_APLICA
    // y ese estado es final); esto es la segunda barrera.
    const ajeno = enCola.find((e) => e.modo !== 'VERIFACTU');
    if (ajeno) {
      throw new ErrorDominio('INTEGRIDAD', 'Hay un registro NO VERI*FACTU en la cola de remisión voluntaria', {
        empresaId,
        registroId: ajeno.registroId,
      });
    }

    // ¿Toca enviar? Ha pasado la espera, o hay un mensaje lleno acumulado (art. 16.2.c).
    const mensajeLleno = control.fallosConsecutivos === 0 && enCola.length >= MAX_REGISTROS_POR_ENVIO;
    if (control.proximoEnvioEn > ahora && !mensajeLleno) {
      return {
        tipo: 'NADA',
        estado: 'EN_ESPERA',
        pendientes: await contarSinRemitir(tx, empresaId),
        proximoEnvioEn: control.proximoEnvioEn,
      };
    }

    const obligado = await leerObligado(tx, empresaId);
    if (!obligado) {
      throw new ErrorDominio('INTEGRIDAD', 'La empresa de la cola de envíos no existe', { empresaId });
    }

    // «Incidencia» = S si el mensaje lleva registros que no pudieron remitirse
    // a su tiempo: hay una incidencia abierta o alguno ya se intentó antes.
    const incidencia = control.incidenciaDesde !== null || enCola.some((e) => e.intentos > 0);
    const endpoint = config.endpoints.VOLUNTARIA;
    const xml = construirMensajeRemision(
      { obligado, remision: { tipo: 'VOLUNTARIA', incidencia } },
      enCola.map((e) => e.xmlRegistro)
    );

    const lote = await insertarLote(tx, {
      empresaId,
      tipoRemision: 'VOLUNTARIA',
      entorno: config.entorno,
      endpoint,
      incidencia,
      numRegistros: enCola.length,
      primerNumSecuencia: enCola[0].numSecuencia,
      ultimoNumSecuencia: enCola[enCola.length - 1].numSecuencia,
      peticionSha256: sha256Hex(xml),
      iniciadoEn: ahora,
    });

    const tomados = await marcarEnviando(tx, empresaId, enCola.map((e) => e.registroId), lote.id, ahora);
    if (tomados !== enCola.length) {
      // Imposible con el cerrojo tomado; si ocurre, se deshace todo.
      throw new ErrorDominio('INTEGRIDAD', 'La cola de envíos ha cambiado durante la reserva', { empresaId });
    }

    const cambios = {
      loteEnCursoId: lote.id,
      loteEnCursoCaducaEn: new Date(ahora.getTime() + config.timeoutMs + MARGEN_ARRENDAMIENTO_MS),
      ultimoEnvioEn: ahora,
    };
    await actualizarControl(tx, empresaId, cambios);
    return { tipo: 'LOTE', lote, enviados: enCola, xml, control: { ...control, ...cambios } };
  });
}

/* -------------------------------------------------------------------------- */
/*  Paso 3: liquidación                                                       */
/* -------------------------------------------------------------------------- */

type Liquidacion = Pick<
  ResultadoRemision,
  'aceptados' | 'aceptadosConErrores' | 'rechazados' | 'devueltosACola' | 'pendientes' | 'proximoEnvioEn'
>;

async function liquidar(
  lote: AeatLote,
  enviados: EnvioEnCola[],
  desenlace: DesenlaceEnvio,
  ahora: Date,
  aleatorio: () => number
): Promise<Liquidacion> {
  const empresaId = lote.empresaId;

  return db.transaction(async (tx): Promise<Liquidacion> => {
    const control = await bloquearControl(tx, empresaId, { esperar: true });
    if (!control) {
      throw new ErrorDominio('INTEGRIDAD', 'La empresa no tiene control de flujo', { empresaId });
    }
    // Si el arrendamiento caducó mientras esperábamos la respuesta, otro
    // proceso ya devolvió los registros a la cola (y quizá los reenvió). La
    // respuesta se sigue aplicando a los registros que aún son de este lote,
    // pero el calendario de la empresa ya no es nuestro.
    const titular = control.loteEnCursoId === lote.id;
    const cuenta = { aceptados: 0, aceptadosConErrores: 0, rechazados: 0, devueltosACola: 0 };
    let fallos = control.fallosConsecutivos;
    let tiempoEsperaSeg = control.tiempoEsperaSeg;
    let error: { codigo: string; mensaje: string } | null = null;
    let requiereIntervencion = control.requiereIntervencion;

    if (desenlace.tipo === 'RESPUESTA') {
      const { respuesta } = desenlace;
      const lineas = emparejarLineas(enviados, respuesta.lineas);

      // Se agrupan los registros con idéntico desenlace: lo habitual (todo
      // «Correcto») se resuelve con una sola sentencia para los 1.000.
      const grupos = new Map<string, { ids: string[]; desenlace: DesenlaceRegistro; linea: LineaRespuesta }>();
      const sinLinea: string[] = [];
      for (const enviado of enviados) {
        const linea = lineas.get(enviado.registroId);
        if (!linea) {
          sinLinea.push(enviado.registroId);
          continue;
        }
        const d = desenlaceDeLinea(linea, { csv: respuesta.csv, entregaIncierta: enviado.entregaIncierta });
        const clave = JSON.stringify([d, linea.estadoRegistro, linea.duplicado]);
        const grupo = grupos.get(clave) ?? { ids: [], desenlace: d, linea };
        grupo.ids.push(enviado.registroId);
        grupos.set(clave, grupo);
      }

      for (const { ids, desenlace: d, linea } of grupos.values()) {
        const n = await cerrarEnvios(tx, empresaId, lote.id, ids, {
          estado: d.estado,
          csv: d.csv,
          codigoError: d.codigoError,
          descripcionError: d.descripcionError,
          // Lo que dijo la AEAT de este registro, para auditoría y soporte.
          respuestaAeat: {
            loteId: lote.id,
            csv: respuesta.csv,
            estadoEnvio: respuesta.estadoEnvio,
            estadoRegistro: linea.estadoRegistro,
            codigoError: linea.codigoError,
            descripcionError: linea.descripcionError,
            registroDuplicado: linea.duplicado,
            conciliado: d.conciliado,
            nifPresentador: respuesta.nifPresentador,
            timestampPresentacion: respuesta.timestampPresentacion,
          },
          ahora,
        });
        if (d.estado === 'ACEPTADO') cuenta.aceptados += n;
        else if (d.estado === 'ACEPTADO_CON_ERRORES') cuenta.aceptadosConErrores += n;
        else cuenta.rechazados += n;
      }

      // La AEAT ha respondido: el servicio funciona. Se reinician los reintentos
      // y se adopta el «t» que indique para el siguiente envío.
      fallos = 0;
      requiereIntervencion = false;
      tiempoEsperaSeg = respuesta.tiempoEsperaSeg ?? control.tiempoEsperaSeg;

      if (sinLinea.length > 0) {
        // Registros enviados de los que la respuesta no dice nada: no se asume
        // ni aceptación ni rechazo; vuelven a la cola como inciertos.
        fallos = 1;
        error = { codigo: 'SIN_LINEA', mensaje: 'La respuesta de la AEAT no incluye todos los registros enviados' };
      }

      await cerrarLote(tx, lote.id, {
        resultado:
          respuesta.estadoEnvio === 'Correcto'
            ? 'CORRECTO'
            : respuesta.estadoEnvio === 'ParcialmenteCorrecto'
              ? 'PARCIALMENTE_CORRECTO'
              : 'INCORRECTO',
        finalizadoEn: ahora,
        estadoHttp: desenlace.estadoHttp,
        csv: respuesta.csv,
        tiempoEsperaSeg: respuesta.tiempoEsperaSeg,
        respuestaXml: desenlace.cuerpo,
        codigoError: error?.codigo,
        descripcionError: error?.mensaje,
      });
    } else {
      // Sin respuesta útil (TRANSITORIO) o mensaje rechazado entero (RECHAZO_ENVIO).
      fallos = control.fallosConsecutivos + 1;
      error = { codigo: desenlace.codigo, mensaje: desenlace.mensaje };
      if (desenlace.tipo === 'RECHAZO_ENVIO') requiereIntervencion = true;

      await cerrarLote(tx, lote.id, {
        resultado: desenlace.tipo === 'RECHAZO_ENVIO' ? 'RECHAZADO' : 'ERROR_TRANSITORIO',
        finalizadoEn: ahora,
        estadoHttp: desenlace.estadoHttp,
        codigoError: desenlace.codigo,
        descripcionError: desenlace.mensaje,
        respuestaXml: desenlace.cuerpo,
      });
    }

    const siguiente = proximoEnvio({
      ahora,
      ultimoEnvioEn: lote.iniciadoEn,
      tiempoEsperaSeg,
      fallosConsecutivos: fallos,
      aleatorio,
    });

    // Todo lo que siga ENVIANDO en este lote vuelve a la cola.
    if (error) {
      cuenta.devueltosACola = await devolverACola(tx, empresaId, {
        loteId: lote.id,
        codigoError: error.codigo,
        descripcionError: `${error.codigo}: ${error.mensaje}`,
        entregaIncierta: desenlace.tipo === 'RESPUESTA' ? true : desenlace.entregaIncierta,
        proximoIntentoEn: siguiente,
        ahora,
      });
    }

    const pendientes = await contarSinRemitir(tx, empresaId);
    if (titular) {
      await actualizarControl(tx, empresaId, {
        loteEnCursoId: null,
        loteEnCursoCaducaEn: null,
        tiempoEsperaSeg,
        fallosConsecutivos: fallos,
        requiereIntervencion,
        proximoEnvioEn: siguiente,
        ultimoErrorCodigo: error?.codigo.slice(0, 20) ?? null,
        ultimoError: error?.mensaje ?? null,
        // La incidencia se abre con el primer fallo y se cierra cuando no queda
        // ningún registro por remitir (mientras tanto, los mensajes llevan «S»).
        incidenciaDesde: error ? (control.incidenciaDesde ?? lote.iniciadoEn) : pendientes === 0 ? null : control.incidenciaDesde,
      });
    }

    return { ...cuenta, pendientes, proximoEnvioEn: titular ? siguiente : control.proximoEnvioEn };
  });
}

/* -------------------------------------------------------------------------- */
/*  Remisión de una empresa                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Intenta remitir a la AEAT los registros en cola de UNA empresa (un mensaje,
 * hasta 1.000 registros). Función de sistema: no recibe usuario porque la
 * llaman el worker y la emisión; las rutas que la expongan deben autorizar
 * antes (ver `reintentarRemision`).
 *
 * Nunca lanza por un fallo de la AEAT o de la red: esos desenlaces forman
 * parte del resultado. Solo lanza si la base de datos falla o detecta un
 * estado imposible.
 */
export async function remitirPendientesDeEmpresa(
  empresaId: string,
  deps: DependenciasRemision = {}
): Promise<ResultadoRemision> {
  const { config, transporte, reloj, aleatorio } = resolverDependencias(deps);

  const reserva = await reservar(empresaId, await reloj(), config, aleatorio);
  if (reserva.tipo === 'NADA') {
    return {
      empresaId,
      estado: reserva.estado,
      loteId: null,
      enviados: 0,
      aceptados: 0,
      aceptadosConErrores: 0,
      rechazados: 0,
      devueltosACola: 0,
      pendientes: reserva.pendientes,
      csv: null,
      proximoEnvioEn: reserva.proximoEnvioEn,
      error: null,
    };
  }

  const { lote, enviados, xml } = reserva;
  let desenlace: DesenlaceEnvio;
  try {
    const http = await transporte({ url: lote.endpoint, xml, timeoutMs: config.timeoutMs });
    desenlace = clasificarRespuestaHttp(http, interpretarRespuesta(http.cuerpo));
  } catch (error) {
    desenlace = clasificarErrorDeEnvio(error);
  }

  const liquidacion = await liquidar(lote, enviados, desenlace, await reloj(), aleatorio);

  if (desenlace.tipo !== 'RESPUESTA') {
    registrarError('Remisión a la AEAT', new Error(desenlace.mensaje), {
      empresaId,
      loteId: lote.id,
      tipo: desenlace.tipo,
      codigo: desenlace.codigo,
      estadoHttp: desenlace.estadoHttp,
      registros: enviados.length,
      proximoEnvioEn: liquidacion.proximoEnvioEn,
    });
  }

  return {
    empresaId,
    estado:
      desenlace.tipo === 'RESPUESTA'
        ? 'ENVIADO'
        : desenlace.tipo === 'RECHAZO_ENVIO'
          ? 'ENVIO_RECHAZADO'
          : 'FALLO_TRANSITORIO',
    loteId: lote.id,
    enviados: enviados.length,
    ...liquidacion,
    csv: desenlace.tipo === 'RESPUESTA' ? desenlace.respuesta.csv : null,
    error: desenlace.tipo === 'RESPUESTA' ? null : { codigo: desenlace.codigo, mensaje: desenlace.mensaje },
  };
}

/**
 * Remisión en TIEMPO REAL: se llama justo después de confirmar la emisión o
 * la anulación de una factura. No espera ni propaga errores: la factura ya
 * está válidamente expedida con su registro; si la AEAT no responde, el
 * registro queda en cola y lo recoge el worker.
 *
 * En una acción de servidor de Next.js, envuélvala en `after()` para que el
 * envío continúe una vez devuelta la respuesta al usuario:
 *
 *     const resultado = await emitirFactura(ctx, empresaId, facturaId);
 *     after(() => remitirTrasEmision(resultado.registro.empresaId));
 */
export async function remitirTrasEmision(empresaId: string, deps: DependenciasRemision = {}): Promise<void> {
  try {
    await remitirPendientesDeEmpresa(empresaId, deps);
  } catch (error) {
    registrarError('Remisión inmediata a la AEAT', error, { empresaId });
  }
}

/* -------------------------------------------------------------------------- */
/*  Worker: recorrido de la cola                                              */
/* -------------------------------------------------------------------------- */

export type ResumenCola = {
  empresasProcesadas: number;
  porEstado: Partial<Record<EstadoRemision | 'ERROR', number>>;
  registrosAceptados: number;
  registrosRechazados: number;
};

/**
 * Una pasada del worker: remite los registros de todas las empresas a las que
 * les toca. Debe ejecutarse de forma periódica (cada minuto es lo razonable:
 * coincide con el «t» inicial del control de flujo), mediante una tarea
 * programada que llame a `/api/cron/aeat` o el temporizador de
 * `instrumentation.ts`. Puede haber varias pasadas simultáneas en distintos
 * servidores: el cerrojo por empresa evita que se pisen.
 */
export async function procesarCola(
  deps: DependenciasRemision = {},
  opciones: { maxEmpresas?: number; concurrencia?: number } = {}
): Promise<ResumenCola> {
  const { reloj } = resolverDependencias(deps);
  const maxEmpresas = opciones.maxEmpresas ?? 200;
  const concurrencia = Math.max(1, opciones.concurrencia ?? 5);

  const empresas = await empresasConEnviosListos(db, await reloj(), maxEmpresas);
  const resumen: ResumenCola = { empresasProcesadas: 0, porEstado: {}, registrosAceptados: 0, registrosRechazados: 0 };

  // Unas pocas empresas a la vez: cada una ocupa una conexión a la base de
  // datos y una petición a la AEAT mientras dura su envío.
  let siguiente = 0;
  const trabajador = async () => {
    while (siguiente < empresas.length) {
      const empresaId = empresas[siguiente++];
      let estado: EstadoRemision | 'ERROR';
      try {
        const r = await remitirPendientesDeEmpresa(empresaId, deps);
        estado = r.estado;
        resumen.registrosAceptados += r.aceptados + r.aceptadosConErrores;
        resumen.registrosRechazados += r.rechazados;
      } catch (error) {
        // El fallo de una empresa no detiene la remisión de las demás.
        estado = 'ERROR';
        registrarError('Worker de remisión a la AEAT', error, { empresaId });
      }
      resumen.empresasProcesadas++;
      resumen.porEstado[estado] = (resumen.porEstado[estado] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrencia, empresas.length) }, trabajador));
  return resumen;
}

/* -------------------------------------------------------------------------- */
/*  Estado de la remisión (para la interfaz)                                  */
/* -------------------------------------------------------------------------- */

export type EstadoRemisionEmpresa = {
  modo: 'VERIFACTU' | 'NO_VERIFACTU';
  /** Registros generados en modo VERI*FACTU que aún no constan en la AEAT. */
  pendientes: number;
  envios: Record<EnvioAeat['estado'], number>;
  /** Incidencia abierta: hay registros que no han podido remitirse a su tiempo. */
  incidencia: { desde: Date; codigo: string | null; mensaje: string | null; requiereIntervencion: boolean } | null;
  /**
   * Aviso que la aplicación DEBE mostrar mientras dure la incidencia, con el
   * número de registros que faltan por remitir (art. 16.4 de la Orden).
   */
  aviso: string | null;
  tiempoEsperaSeg: number;
  proximoEnvioEn: Date | null;
  ultimosEnvios: Pick<
    AeatLote,
    'id' | 'tipoRemision' | 'resultado' | 'numRegistros' | 'csv' | 'codigoError' | 'descripcionError' | 'iniciadoEn' | 'finalizadoEn'
  >[];
};

export async function estadoRemision(ctx: ContextoUsuario, empresaId: unknown): Promise<EstadoRemisionEmpresa> {
  const empresa = await cargarEmpresa(ctx, empresaId);
  const [control, envios, lotes] = await Promise.all([
    leerControl(db, empresa.id),
    resumenEnvios(db, empresa.id),
    ultimosLotes(db, empresa.id, 10),
  ]);
  const pendientes = envios.PENDIENTE + envios.ERROR_TRANSITORIO + envios.ENVIANDO;
  const enIncidencia = control?.incidenciaDesde != null && pendientes > 0;

  let aviso: string | null = null;
  if (enIncidencia) {
    const cuantos = pendientes === 1 ? 'Falta 1 registro' : `Faltan ${pendientes} registros`;
    aviso =
      `Incidencia en el envío a la Agencia Tributaria. ${cuantos} de facturación por remitir. ` +
      (control!.requiereIntervencion
        ? 'La Agencia Tributaria está rechazando los envíos: contacte con soporte.'
        : 'Se reintenta automáticamente; puede seguir facturando con normalidad.');
  }

  return {
    modo: empresa.modoVerifactu,
    pendientes,
    envios,
    incidencia: enIncidencia
      ? {
          desde: control!.incidenciaDesde!,
          codigo: control!.ultimoErrorCodigo,
          mensaje: control!.ultimoError,
          requiereIntervencion: control!.requiereIntervencion,
        }
      : null,
    aviso,
    tiempoEsperaSeg: control?.tiempoEsperaSeg ?? TIEMPO_ESPERA_INICIAL_SEG,
    proximoEnvioEn: pendientes > 0 ? (control?.proximoEnvioEn ?? null) : null,
    ultimosEnvios: lotes.map((l) => ({
      id: l.id,
      tipoRemision: l.tipoRemision,
      resultado: l.resultado,
      numRegistros: l.numRegistros,
      csv: l.csv,
      codigoError: l.codigoError,
      descripcionError: l.descripcionError,
      iniciadoEn: l.iniciadoEn,
      finalizadoEn: l.finalizadoEn,
    })),
  };
}

/**
 * «Reintentar ahora» desde la interfaz. Comprueba que la empresa es de la
 * cuenta del usuario y lanza un intento, que sigue sujeto al control de flujo
 * y a la espera de reintento (puede responder EN_ESPERA).
 */
export async function reintentarRemision(
  ctx: ContextoUsuario,
  empresaId: unknown,
  deps: DependenciasRemision = {}
): Promise<ResultadoRemision> {
  const empresa = await cargarEmpresa(ctx, empresaId);
  return remitirPendientesDeEmpresa(empresa.id, deps);
}
