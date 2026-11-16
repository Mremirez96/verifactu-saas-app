import { db, type Transaction } from '@/lib/db/drizzle';
import type { Empresa, Factura, RegistroVerifactu } from '@/lib/db/schema';
import type { ContextoUsuario } from '../contexto';
import {
  contenidoQr,
  eslabonIntegro,
  fechaEnHuso,
  fechaHoraHuso,
  huellaRegistroAlta,
  TIPO_HUELLA_SHA256,
  verificarCadena,
  type ContenidoQr,
  type ResultadoVerificacion,
} from '../crypto';
import { leerCadenas } from '../empresas/repositorio';
import { cargarEmpresa } from '../empresas/servicio';
import { comoErrorPostgres, ErrorDominio, traducirErrorBd } from '../errores';
import { entornoAeat, SISTEMA_INFORMATICO } from '../sif';
import { uuid, validar } from '../validacion';
import {
  bloquearCadena,
  buscarFacturaParaEmitir,
  buscarRegistro,
  horaServidor,
  insertarRegistro,
  listarCadena,
  marcarEmitida,
  type CabeceraCadena,
} from './repositorio';

/* -------------------------------------------------------------------------- */
/*  Contrato con el generador de XML (siguiente fase)                         */
/* -------------------------------------------------------------------------- */

/**
 * Todo lo que el generador de XML necesita para escribir el «RegistroAlta».
 * La huella, la fecha-hora y el QR llegan YA calculados: el XML debe
 * reproducirlos tal cual, sin volver a dar formato a nada.
 */
export type DatosRegistroAlta = {
  empresa: Pick<Empresa, 'id' | 'nif' | 'nombreRazon' | 'modoVerifactu'>;
  factura: Factura;
  encadenamiento:
    | { esPrimerRegistro: true; registroAnterior: null }
    | {
        esPrimerRegistro: false;
        /** Bloque «RegistroAnterior»: identifica el eslabón previo. */
        registroAnterior: {
          idEmisorFactura: string;
          numSerieFactura: string;
          fechaExpedicion: string;
          huella: string;
        };
      };
  sistemaInformatico: typeof SISTEMA_INFORMATICO & { numeroInstalacion: string };
  fechaHoraHusoGen: string;
  tipoHuella: typeof TIPO_HUELLA_SHA256;
  huella: string;
  qrUrl: string;
};

/**
 * El registro se guarda en una tabla de SOLO INSERCIÓN: lo que se escriba hoy
 * en `xml_registro` no se podrá corregir nunca. Por eso el generador de XML
 * no tiene valor por defecto ni sustituto provisional: quien llama a
 * `emitirFactura` tiene que aportarlo, y hasta que exista el generador real
 * (validado contra los XSD de la AEAT) la emisión no se expone en ninguna
 * acción ni ruta.
 */
export type DependenciasEmision = {
  serializarRegistroAlta: (datos: DatosRegistroAlta) => string;
  /** Espera máxima por el cerrojo de la cadena. Por defecto, 10 s. */
  esperaCerrojoMs?: number;
};

export type ResultadoEmision = {
  factura: Factura;
  registro: RegistroVerifactu;
  qr: ContenidoQr;
};

/* -------------------------------------------------------------------------- */
/*  Emisión: factura + registro de alta, en una única transacción             */
/* -------------------------------------------------------------------------- */

/**
 * Emite una factura en BORRADOR y genera su registro de facturación de alta.
 *
 * SECUENCIA (todo dentro de una transacción; o se confirma entero o nada):
 *
 *   1. Cerrojo de la cadena de la empresa        → vf_bloquear_cadena()
 *      A partir de aquí esta transacción es la ÚNICA que puede añadir un
 *      eslabón a la cadena de esa empresa. Es siempre el primer bloqueo que
 *      se toma, para que dos emisiones no puedan esperarse mutuamente.
 *   2. Comprobación del último eslabón           → art. 7.i.1º de la Orden
 *   3. BORRADOR → EMITIDA                        → la BD asigna el número
 *   4. Fecha-hora de generación                  → reloj de la BD, tras el cerrojo
 *   5. Huella SHA-256 encadenada + contenido del QR
 *   6. INSERT del registro                       → el trigger revalida el
 *      enlace, asigna la secuencia, avanza la cabecera y encola el envío
 *   7. COMMIT                                    → se libera el cerrojo y un
 *      trigger diferido confirma que la factura emitida tiene su registro
 *
 * Si algo falla entre 1 y 7, el ROLLBACK devuelve el número a la serie y deja
 * la cadena como estaba: no hay huecos ni eslabones a medias.
 */
export async function emitirFactura(
  ctx: ContextoUsuario,
  empresaId: unknown,
  facturaId: unknown,
  dependencias: DependenciasEmision
): Promise<ResultadoEmision> {
  const idFactura = validar(uuid('factura'), facturaId);
  const entorno = entornoAeat(); // falla ANTES de abrir la transacción si falta configuración

  try {
    return await db.transaction(async (tx) => {
      const empresa = await cargarEmpresa(ctx, empresaId, tx);
      if (!empresa.activa) {
        throw new ErrorDominio('CONFLICTO', 'La empresa está inactiva y no puede emitir facturas');
      }
      // NO VERI*FACTU exige firmar el registro (XAdES); llegará con el módulo de firma.
      if (empresa.modoVerifactu !== 'VERIFACTU') {
        throw new ErrorDominio('VALIDACION', 'La emisión en modo NO VERI*FACTU todavía no está disponible');
      }

      // (1) Cerrojo. La huella anterior se lee AQUÍ, nunca antes.
      const cabecera = await bloquearCadena(tx, empresa.id, 'FACTURACION', dependencias.esperaCerrojoMs);
      if (!cabecera) {
        throw new ErrorDominio('INTEGRIDAD', 'La empresa no tiene cadena de facturación', { empresaId: empresa.id });
      }

      // (2) No se encadena sobre un eslabón dañado.
      const anterior = await comprobarUltimoEslabon(tx, empresa.id, cabecera);

      // (3) La factura pasa a EMITIDA con la foto fija del emisor.
      const borrador = await buscarFacturaParaEmitir(tx, empresa.id, idFactura);
      if (!borrador) {
        throw new ErrorDominio('NO_ENCONTRADO', 'Factura no encontrada');
      }
      if (borrador.estado !== 'BORRADOR') {
        throw new ErrorDominio('CONFLICTO', `La factura ${borrador.numSerieFactura} ya está emitida`);
      }

      // (4) Un único instante, leído con el cerrojo ya tomado, fecha la factura y el registro.
      const ahora = await horaServidor(tx);
      const factura = await marcarEmitida(tx, empresa.id, borrador.id, {
        emisorNif: empresa.nif,
        emisorNombreRazon: empresa.nombreRazon,
        emisorDomicilio: domicilio(empresa),
        // La fecha de expedición es la del día en que se genera el registro,
        // en el calendario del territorio de la empresa. No se puede antedatar.
        fechaExpedicion: fechaEnHuso(ahora, empresa.husoHorario),
      });
      if (!factura.numSerieFactura || !factura.fechaExpedicion || !factura.emisorNif) {
        throw new ErrorDominio('INTEGRIDAD', 'La factura emitida no tiene número, fecha o emisor', { facturaId: factura.id });
      }

      // (5) Huella encadenada: su entrada incluye la huella del registro anterior.
      const fechaHoraHusoGen = fechaHoraHuso(ahora, empresa.husoHorario);
      const huella = huellaRegistroAlta({
        idEmisorFactura: factura.emisorNif,
        numSerieFactura: factura.numSerieFactura,
        fechaExpedicion: factura.fechaExpedicion,
        tipoFactura: factura.tipoFactura,
        cuotaTotal: factura.cuotaTotal,
        importeTotal: factura.importeTotal,
        huellaAnterior: cabecera.ultimaHuella,
        fechaHoraHusoGen,
      });

      const qr = contenidoQr({
        nif: factura.emisorNif,
        numSerieFactura: factura.numSerieFactura,
        fechaExpedicion: factura.fechaExpedicion,
        importeTotal: factura.importeTotal,
        modo: empresa.modoVerifactu,
        entorno,
      });

      const sistemaInformatico = { ...SISTEMA_INFORMATICO, numeroInstalacion: empresa.numeroInstalacion };
      const xmlRegistro = dependencias.serializarRegistroAlta({
        empresa,
        factura,
        encadenamiento: anterior
          ? {
              esPrimerRegistro: false,
              registroAnterior: {
                idEmisorFactura: anterior.idEmisorFactura,
                numSerieFactura: anterior.numSerieFactura,
                fechaExpedicion: anterior.fechaExpedicion,
                huella: anterior.huella,
              },
            }
          : { esPrimerRegistro: true, registroAnterior: null },
        sistemaInformatico,
        fechaHoraHusoGen,
        tipoHuella: TIPO_HUELLA_SHA256,
        huella,
        qrUrl: qr.url,
      });
      if (typeof xmlRegistro !== 'string' || xmlRegistro.trim() === '') {
        throw new ErrorDominio('INTEGRIDAD', 'El generador de XML no ha devuelto el registro de alta');
      }

      // (6) Inserción. El trigger vuelve a comprobar el enlace contra la cabecera.
      const registro = await insertarRegistro(tx, {
        empresaId: empresa.id,
        facturaId: factura.id,
        tipoRegistro: 'ALTA',
        idEmisorFactura: factura.emisorNif,
        nombreRazonEmisor: empresa.nombreRazon,
        numSerieFactura: factura.numSerieFactura,
        fechaExpedicion: factura.fechaExpedicion,
        tipoFactura: factura.tipoFactura,
        cuotaTotal: factura.cuotaTotal,
        importeTotal: factura.importeTotal,
        fechaHoraHusoGen,
        esPrimerRegistro: anterior === null,
        registroAnteriorId: cabecera.ultimoId,
        huellaAnterior: cabecera.ultimaHuella,
        tipoHuella: TIPO_HUELLA_SHA256,
        huella,
        modo: empresa.modoVerifactu,
        sifIdSistema: sistemaInformatico.idSistema,
        sifVersion: sistemaInformatico.version,
        sifNumeroInstalacion: sistemaInformatico.numeroInstalacion,
        xmlRegistro,
        qrUrl: qr.url,
        creadoPor: ctx.usuarioId,
      });

      // Lo guardado tiene que ser, exactamente, lo calculado.
      if (
        registro.huella !== huella ||
        registro.numSecuencia !== cabecera.ultimoNumSecuencia + 1 ||
        !eslabonIntegro(registro)
      ) {
        throw new ErrorDominio('INTEGRIDAD', 'El registro insertado no coincide con el calculado', {
          registroId: registro.id,
        });
      }

      return { factura, registro, qr };
    });
  } catch (error) {
    // 55P03 = lock_not_available: otra emisión de la misma empresa no terminó a tiempo.
    if (comoErrorPostgres(error)?.code === '55P03') {
      throw new ErrorDominio('CONFLICTO', 'Hay otra emisión en curso para esta empresa. Inténtelo de nuevo.');
    }
    traducirErrorBd(error, {
      facturas_emitida_completa_ck: 'La factura no se puede emitir: le faltan datos obligatorios (descripción de la operación)',
      facturas_destinatario_ck: 'Este tipo de factura exige un destinatario identificado con nombre y NIF',
    });
  }
}

/**
 * Art. 7.i.1º de la Orden: antes de generar un registro hay que comprobar que
 * el último generado está correctamente encadenado. Devuelve ese último
 * registro (o `null` si la cadena está vacía).
 */
async function comprobarUltimoEslabon(
  tx: Transaction,
  empresaId: string,
  cabecera: CabeceraCadena
): Promise<RegistroVerifactu | null> {
  if (cabecera.ultimoId === null) {
    if (cabecera.ultimaHuella !== null || cabecera.ultimoNumSecuencia !== 0) {
      throw anomaliaDeCadena('La cabecera de una cadena vacía tiene datos', empresaId);
    }
    return null;
  }

  const ultimo = await buscarRegistro(tx, empresaId, cabecera.ultimoId);
  if (!ultimo) {
    throw anomaliaDeCadena('El último registro de la cadena no existe', empresaId);
  }
  if (ultimo.huella !== cabecera.ultimaHuella || ultimo.numSecuencia !== cabecera.ultimoNumSecuencia) {
    throw anomaliaDeCadena('El último registro no coincide con la cabecera de la cadena', empresaId);
  }
  if (!eslabonIntegro(ultimo)) {
    throw anomaliaDeCadena('La huella del último registro no corresponde a su contenido', empresaId);
  }
  return ultimo;
}

/**
 * Cuando el sistema detecta que no puede garantizar el encadenamiento debe
 * dejar de emitir, mostrar una alarma y generar un registro de evento
 * (art. 6.f y 7.j). Aquí se corta la emisión; la alarma y el evento llegarán
 * con el motor de eventos.
 */
function anomaliaDeCadena(motivo: string, empresaId: string): ErrorDominio {
  return new ErrorDominio('INTEGRIDAD', `Cadena de facturación no fiable: ${motivo}`, { empresaId });
}

function domicilio(empresa: Empresa): string | null {
  const partes = [empresa.direccion, [empresa.codigoPostal, empresa.municipio].filter(Boolean).join(' '), empresa.provincia];
  return partes.filter(Boolean).join(', ') || null;
}

/* -------------------------------------------------------------------------- */
/*  Verificación de la cadena de una empresa                                  */
/* -------------------------------------------------------------------------- */

/**
 * Recorre la cadena completa de la empresa y la verifica con el módulo
 * criptográfico, usando como ancla la huella de la cabecera.
 *
 * Se ejecuta en una transacción de solo lectura con instantánea fija
 * (REPEATABLE READ): si entra una emisión a mitad de la lectura, cabecera y
 * registros siguen siendo coherentes entre sí y no hay falsos positivos.
 */
export async function verificarCadenaEmpresa(
  ctx: ContextoUsuario,
  empresaId: unknown
): Promise<ResultadoVerificacion> {
  return db.transaction(
    async (tx) => {
      const empresa = await cargarEmpresa(ctx, empresaId, tx);
      const cabecera = (await leerCadenas(tx, empresa.id)).find((c) => c.tipoCadena === 'FACTURACION');
      if (!cabecera) {
        throw new ErrorDominio('INTEGRIDAD', 'La empresa no tiene cadena de facturación', { empresaId: empresa.id });
      }
      const registros = await listarCadena(tx, empresa.id);
      return verificarCadena(registros, { ultimaHuellaEsperada: cabecera.ultimaHuella });
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}
