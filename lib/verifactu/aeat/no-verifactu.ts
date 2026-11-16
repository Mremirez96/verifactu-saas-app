import { and, count, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/lib/db/drizzle';
import { ActivityType, enviosAeat, registrosVerifactu, type AeatLote } from '@/lib/db/schema';
import { registrarActividad } from '../actividad';
import { exigirPropietario, type ContextoUsuario } from '../contexto';
import { sha256Hex, type ResultadoVerificacion } from '../crypto';
import { cargarEmpresa } from '../empresas/servicio';
import { ErrorDominio } from '../errores';
import { verificarCadenaEmpresa } from '../registros/servicio';
import { uuid, validar } from '../validacion';
import { resolverDependencias, type DependenciasRemision } from './remision';
import { cerrarLote, insertarLote, leerTramoDeCadena } from './repositorio';
import { clasificarErrorDeEnvio, clasificarRespuestaHttp, emparejarLineas, type DesenlaceEnvio } from './respuesta';
import { construirMensajeRemision, interpretarRespuesta, MAX_REGISTROS_POR_ENVIO } from './soap';

/**
 * CONTROLES DEL MODO «NO VERI*FACTU»
 *
 * Una empresa en este modo NO remite sus registros a la AEAT de forma
 * automática: los CONSERVA, encadenados y firmados, y solo los entrega cuando
 * la Administración se los requiere (art. 14.2 del RD 1007/2023: copia en
 * formato electrónico, en soporte físico o por envío automático y seguro a
 * su sede electrónica).
 *
 * Cómo lo garantiza el sistema, de dentro hacia fuera:
 *
 *   1. BASE DE DATOS. Cada registro nace en la cola con el estado que marca
 *      el modo en que se generó: PENDIENTE (VERI*FACTU) o NO_APLICA (NO
 *      VERI*FACTU). NO_APLICA es un estado final y nadie puede entrar en él
 *      ni salir de él después (trigger `vf_envios_guard`): un registro NO
 *      VERI*FACTU no puede colarse en la cola, y uno VERI*FACTU pendiente no
 *      puede retirarse de ella.
 *   2. COLA. `remision.ts` solo toma PENDIENTE / ERROR_TRANSITORIO y, además,
 *      aborta si encuentra un registro de otro modo.
 *   3. ESTE MÓDULO. Las dos únicas salidas de los registros conservados:
 *        · `remitirPorRequerimiento` → servicio «RequerimientoSOAP» de la AEAT;
 *        · `exportarRegistros`       → ficheros XML (el «soporte físico»).
 *      Ambas son manuales, exigen ser propietario de la cuenta y quedan
 *      anotadas; ninguna cambia el estado NO_APLICA de los registros.
 *
 * El modo se decide REGISTRO A REGISTRO, no por la configuración actual de la
 * empresa: si una empresa deja VERI*FACTU, los registros que generó en ese
 * modo y aún no ha remitido se siguen enviando hasta vaciar la cola.
 *
 * PENDIENTE (no es de esta fase): la EMISIÓN en modo NO VERI*FACTU sigue
 * bloqueada en registros/servicio.ts hasta que exista el módulo de firma
 * XAdES y el registro de eventos, que la Orden exige en este modo.
 */

/* -------------------------------------------------------------------------- */
/*  Remisión en respuesta a un requerimiento                                  */
/* -------------------------------------------------------------------------- */

const requerimientoSchema = z.object({
  /** Referencia que figura en el requerimiento de la AEAT. */
  refRequerimiento: z.string().trim().min(1, 'Indique la referencia del requerimiento').max(18, 'La referencia tiene 18 caracteres como máximo'),
  /** Tramo de la cadena a remitir, por número de secuencia (ambos incluidos). */
  desdeSecuencia: z.coerce.number().int().min(1).default(1),
  hastaSecuencia: z.coerce.number().int().min(1).optional(),
});

export type ResultadoRequerimiento = {
  loteId: string;
  resultado: AeatLote['resultado'];
  csv: string | null;
  enviados: number;
  /** TRUE si este mensaje cerró el requerimiento («FinRequerimiento» = S). */
  finRequerimiento: boolean;
  /** Si quedan registros del tramo, por dónde seguir en la siguiente llamada. */
  siguienteSecuencia: number | null;
  /** Segundos que hay que esperar antes del siguiente mensaje. */
  tiempoEsperaSeg: number | null;
  registros: {
    registroId: string;
    numSecuencia: number;
    numSerieFactura: string;
    estadoRegistro: string | null;
    codigoError: string | null;
    descripcionError: string | null;
  }[];
  error: { codigo: string; mensaje: string } | null;
};

/**
 * Remite a la AEAT, por el servicio de requerimientos, un tramo de los
 * registros conservados en modo NO VERI*FACTU (art. 14.2 RD 1007/2023 y
 * art. 18 de la Orden HAC/1177/2024).
 *
 * Mismas características que la remisión voluntaria, con tres diferencias:
 *   · otro servicio (…/RequerimientoSOAP) y cabecera «RemisionRequerimiento»
 *     con la referencia del requerimiento en TODOS los mensajes;
 *   · es una operación manual y puntual: no hay cola ni reintentos
 *     automáticos, y el estado de los registros (NO_APLICA) no cambia;
 *   · los registros viajan tal como se conservan, con su firma electrónica.
 *
 * Cada llamada envía UN mensaje (hasta 1.000 registros). Si el tramo no cabe,
 * devuelve `siguienteSecuencia`; quien llama repite pasada la espera que
 * indique la AEAT. El último mensaje lleva «FinRequerimiento» = S.
 */
export async function remitirPorRequerimiento(
  ctx: ContextoUsuario,
  empresaId: unknown,
  entrada: unknown,
  deps: DependenciasRemision = {}
): Promise<ResultadoRequerimiento> {
  exigirPropietario(ctx);
  const datos = validar(requerimientoSchema, entrada);
  if (datos.hastaSecuencia !== undefined && datos.hastaSecuencia < datos.desdeSecuencia) {
    throw new ErrorDominio('VALIDACION', 'El tramo de registros no es válido');
  }
  const empresa = await cargarEmpresa(ctx, empresaId);
  const { config, transporte, reloj } = resolverDependencias(deps);

  // Uno de más para saber si quedan registros después de este mensaje.
  const tramo = await leerTramoDeCadena(db, empresa.id, {
    desde: datos.desdeSecuencia,
    hasta: datos.hastaSecuencia,
    limite: MAX_REGISTROS_POR_ENVIO + 1,
    modo: 'NO_VERIFACTU',
  });
  if (tramo.length === 0) {
    throw new ErrorDominio('NO_ENCONTRADO', 'No hay registros conservados en modo NO VERI*FACTU en ese tramo');
  }
  const registros = tramo.slice(0, MAX_REGISTROS_POR_ENVIO);
  const quedanMas = tramo.length > MAX_REGISTROS_POR_ENVIO;

  // El anexo de la Orden exige la firma XAdES (art. 14) para conservar y para
  // responder a un requerimiento; solo la remisión voluntaria prescinde de ella.
  const sinFirma = registros.find((r) => !r.xmlFirmado);
  if (sinFirma) {
    throw new ErrorDominio('INTEGRIDAD', 'Hay registros NO VERI*FACTU sin firma electrónica', {
      empresaId: empresa.id,
      registroId: sinFirma.id,
    });
  }

  const xml = construirMensajeRemision(
    {
      obligado: { nombreRazon: empresa.nombreRazon, nif: empresa.nif },
      remision: { tipo: 'REQUERIMIENTO', refRequerimiento: datos.refRequerimiento, finRequerimiento: !quedanMas },
    },
    registros.map((r) => r.xmlRegistro)
  );

  // El lote se anota ANTES de salir a la red: queda constancia aunque falle.
  const lote = await insertarLote(db, {
    empresaId: empresa.id,
    tipoRemision: 'REQUERIMIENTO',
    entorno: config.entorno,
    endpoint: config.endpoints.REQUERIMIENTO,
    refRequerimiento: datos.refRequerimiento,
    numRegistros: registros.length,
    primerNumSecuencia: registros[0].numSecuencia,
    ultimoNumSecuencia: registros[registros.length - 1].numSecuencia,
    peticionSha256: sha256Hex(xml),
    iniciadoEn: await reloj(),
  });

  let desenlace: DesenlaceEnvio;
  try {
    const http = await transporte({ url: lote.endpoint, xml, timeoutMs: config.timeoutMs });
    desenlace = clasificarRespuestaHttp(http, interpretarRespuesta(http.cuerpo));
  } catch (error) {
    desenlace = clasificarErrorDeEnvio(error);
  }

  const lineas =
    desenlace.tipo === 'RESPUESTA'
      ? emparejarLineas(
          registros.map((r) => ({
            registroId: r.id,
            numSerieFactura: r.numSerieFactura,
            tipoRegistro: r.tipoRegistro,
            esSubsanacion: r.esSubsanacion,
          })),
          desenlace.respuesta.lineas
        )
      : null;
  const detalle = registros.map((r) => {
    const linea = lineas?.get(r.id);
    return {
      registroId: r.id,
      numSecuencia: r.numSecuencia,
      numSerieFactura: r.numSerieFactura,
      estadoRegistro: linea?.estadoRegistro ?? null,
      codigoError: linea?.codigoError ?? null,
      descripcionError: linea?.descripcionError ?? null,
    };
  });

  const resultado: AeatLote['resultado'] =
    desenlace.tipo === 'RESPUESTA'
      ? desenlace.respuesta.estadoEnvio === 'Correcto'
        ? 'CORRECTO'
        : desenlace.respuesta.estadoEnvio === 'ParcialmenteCorrecto'
          ? 'PARCIALMENTE_CORRECTO'
          : 'INCORRECTO'
      : desenlace.tipo === 'RECHAZO_ENVIO'
        ? 'RECHAZADO'
        : 'ERROR_TRANSITORIO';
  const csv = desenlace.tipo === 'RESPUESTA' ? desenlace.respuesta.csv : null;
  const tiempoEsperaSeg = desenlace.tipo === 'RESPUESTA' ? desenlace.respuesta.tiempoEsperaSeg : null;
  const error = desenlace.tipo === 'RESPUESTA' ? null : { codigo: desenlace.codigo, mensaje: desenlace.mensaje };

  await db.transaction(async (tx) => {
    await cerrarLote(tx, lote.id, {
      resultado,
      finalizadoEn: await reloj(),
      estadoHttp: desenlace.estadoHttp,
      csv,
      tiempoEsperaSeg,
      respuestaXml: desenlace.cuerpo,
      codigoError: error?.codigo,
      descripcionError: error?.mensaje,
      resultadoRegistros: detalle,
    });
    await registrarActividad(
      tx,
      ctx,
      ActivityType.REMISION_REQUERIMIENTO,
      `${empresa.nif} ref. ${datos.refRequerimiento}: ${registros.length} registros (${resultado})`
    );
  });

  const entregado = desenlace.tipo === 'RESPUESTA';
  return {
    loteId: lote.id,
    resultado,
    csv,
    enviados: registros.length,
    finRequerimiento: entregado && !quedanMas,
    // Si el mensaje no llegó, se repite desde el mismo punto.
    siguienteSecuencia: !entregado
      ? registros[0].numSecuencia
      : quedanMas
        ? tramo[MAX_REGISTROS_POR_ENVIO].numSecuencia
        : null,
    tiempoEsperaSeg,
    registros: detalle,
    error,
  };
}

/* -------------------------------------------------------------------------- */
/*  Exportación de los registros conservados                                  */
/* -------------------------------------------------------------------------- */

const exportacionSchema = z.object({
  desdeSecuencia: z.coerce.number().int().min(1).default(1),
  hastaSecuencia: z.coerce.number().int().min(1).optional(),
});

export type FicheroRegistro = {
  /** NIF_secuencia_TIPO.xml */
  nombre: string;
  numSecuencia: number;
  huella: string;
  firmado: boolean;
  /** Documento XML del registro, exactamente como se conserva. */
  contenido: string;
};

/**
 * Volcado de los registros de facturación de una empresa a ficheros XML
 * legibles, uno por registro, con el formato de conservación y exportación
 * del anexo de la Orden (apartado 3): el bloque «RegistroAlta» o
 * «RegistroAnulacion» tal como se guardó, con su huella y, en su caso, su
 * firma. Cubre el procedimiento de descarga del art. 8.2.c del RD 1007/2023
 * y la entrega «en soporte físico» del art. 14.2. Vale para ambos modos.
 *
 * Devuelve hasta 1.000 registros por llamada y `siguienteSecuencia` si hay más.
 */
export async function exportarRegistros(
  ctx: ContextoUsuario,
  empresaId: unknown,
  entrada: unknown = {}
): Promise<{ ficheros: FicheroRegistro[]; siguienteSecuencia: number | null }> {
  exigirPropietario(ctx);
  const datos = validar(exportacionSchema, entrada);
  const empresa = await cargarEmpresa(ctx, empresaId);

  const tramo = await leerTramoDeCadena(db, empresa.id, {
    desde: datos.desdeSecuencia,
    hasta: datos.hastaSecuencia,
    limite: MAX_REGISTROS_POR_ENVIO + 1,
  });
  const registros = tramo.slice(0, MAX_REGISTROS_POR_ENVIO);

  const ficheros = registros.map((r) => ({
    nombre: `${empresa.nif}_${String(r.numSecuencia).padStart(10, '0')}_${r.tipoRegistro}.xml`,
    numSecuencia: r.numSecuencia,
    huella: r.huella,
    firmado: r.xmlFirmado,
    contenido: r.xmlRegistro.startsWith('<?xml') ? r.xmlRegistro : `<?xml version="1.0" encoding="UTF-8"?>\n${r.xmlRegistro}`,
  }));

  if (ficheros.length > 0) {
    await registrarActividad(
      db,
      ctx,
      ActivityType.EXPORTAR_REGISTROS,
      `${empresa.nif}: registros ${ficheros[0].numSecuencia}-${ficheros[ficheros.length - 1].numSecuencia}`
    );
  }
  return {
    ficheros,
    siguienteSecuencia: tramo.length > MAX_REGISTROS_POR_ENVIO ? tramo[MAX_REGISTROS_POR_ENVIO].numSecuencia : null,
  };
}

/* -------------------------------------------------------------------------- */
/*  Comprobación de la conservación                                           */
/* -------------------------------------------------------------------------- */

export type InformeConservacion = {
  /** Verificación completa de la cadena de huellas de la empresa. */
  cadena: ResultadoVerificacion;
  /** Registros generados en modo NO VERI*FACTU. */
  registrosConservados: number;
  /** De ellos, sin firma electrónica (debe ser 0). */
  sinFirma: number;
  /** De ellos, fuera del estado NO_APLICA en la cola de remisión (debe ser 0). */
  enColaIndebida: number;
  correcto: boolean;
};

/**
 * Comprueba que los registros conservados en local siguen íntegros,
 * encadenados, firmados y fuera de la remisión automática. Pensado para
 * ejecutarse de forma periódica y antes de atender un requerimiento.
 */
export async function verificarConservacion(ctx: ContextoUsuario, empresaId: unknown): Promise<InformeConservacion> {
  const id = validar(uuid('empresa'), empresaId);
  const cadena = await verificarCadenaEmpresa(ctx, id); // también comprueba que la empresa es de la cuenta

  const deModo = and(eq(registrosVerifactu.empresaId, id), eq(registrosVerifactu.modo, 'NO_VERIFACTU'));
  const [[totales], [indebidos]] = await Promise.all([
    db
      .select({
        conservados: count(),
        sinFirma: sql<number>`count(*) FILTER (WHERE NOT ${registrosVerifactu.xmlFirmado})`,
      })
      .from(registrosVerifactu)
      .where(deModo),
    db
      .select({ n: count() })
      .from(registrosVerifactu)
      .innerJoin(enviosAeat, eq(enviosAeat.registroId, registrosVerifactu.id))
      .where(and(deModo, ne(enviosAeat.estado, 'NO_APLICA'))),
  ]);

  const informe = {
    cadena,
    registrosConservados: Number(totales.conservados),
    sinFirma: Number(totales.sinFirma),
    enColaIndebida: Number(indebidos.n),
  };
  return { ...informe, correcto: cadena.integra && informe.sinFirma === 0 && informe.enColaIndebida === 0 };
}
