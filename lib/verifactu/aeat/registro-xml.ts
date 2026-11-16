import type { FacturaDesglose, FacturaRelacionada } from '@/lib/db/schema';
import { formatearFecha, formatearImporte } from '../crypto';
import { ErrorDominio } from '../errores';
import type { DatosRegistroAlta, DatosRegistroAnulacion, DatosSistemaInformatico } from '../registros/servicio';
import { bloque, campo, NS } from './xml';

/**
 * GENERADOR DEL XML DE LOS REGISTROS DE FACTURACIÓN
 *
 * Escribe los bloques «RegistroAlta» y «RegistroAnulacion» del anexo de la
 * Orden HAC/1177/2024 (apartados 2.3 y 2.4) con la estructura del esquema
 * oficial `SuministroInformacion.xsd`. Los tests validan la salida contra ese
 * XSD (lib/verifactu/aeat/esquemas).
 *
 * TRES REGLAS
 *   1. El ORDEN de los elementos es el del XSD (es una `sequence`): cambiarlo
 *      hace que la AEAT rechace el mensaje completo.
 *   2. Huella, fecha-hora, importes y fechas llegan ya calculados por el
 *      motor criptográfico y se escriben TAL CUAL, con los mismos
 *      formateadores que usó la huella. Si el XML dijera "121.0" y la huella
 *      se calculó con "121.00", la AEAT recalcularía otra huella.
 *   3. El registro es AUTOCONTENIDO: declara su espacio de nombres en su
 *      elemento raíz. Así el texto guardado en `registros_verifactu` es un
 *      documento válido por sí mismo (conservación, exportación, firma XAdES
 *      en modo NO VERI*FACTU) y, a la vez, se incrusta sin tocarlo en el
 *      mensaje de remisión.
 *
 * Módulo PURO: sin base de datos, reloj ni red.
 */

/** «IDVersion» (lista L15). */
export const ID_VERSION = '1.0';

const P = 'sum1'; // prefijo del espacio de nombres de los registros
const t = (nombre: string) => `${P}:${nombre}`;
const RAIZ_NS = `xmlns:${P}="${NS.sum1}"`;

const siNo = (valor: boolean) => (valor ? 'S' : 'N');

/* -------------------------------------------------------------------------- */
/*  Bloques comunes a alta y anulación                                        */
/* -------------------------------------------------------------------------- */

type Encadenamiento = DatosRegistroAlta['encadenamiento'];

/** «Encadenamiento»: o es el primer registro o identifica al anterior con su huella. */
function encadenamiento(enlace: Encadenamiento): string {
  if (enlace.esPrimerRegistro) {
    return bloque(t('Encadenamiento'), [campo(t('PrimerRegistro'), 'S')]);
  }
  const anterior = enlace.registroAnterior;
  return bloque(t('Encadenamiento'), [
    bloque(t('RegistroAnterior'), [
      campo(t('IDEmisorFactura'), anterior.idEmisorFactura),
      campo(t('NumSerieFactura'), anterior.numSerieFactura),
      campo(t('FechaExpedicionFactura'), formatearFecha(anterior.fechaExpedicion)),
      campo(t('Huella'), anterior.huella),
    ]),
  ]);
}

/**
 * «SistemaInformatico»: quién ha producido el software y qué instalación ha
 * generado el registro. Debe coincidir con la declaración responsable.
 */
function sistemaInformatico(sif: DatosSistemaInformatico): string {
  if (!sif.productor.nombreRazon || !sif.productor.nif) {
    // Sin productor no hay registro válido, y un registro guardado no se puede
    // corregir: se corta la emisión antes de escribir nada.
    throw new ErrorDominio(
      'INTEGRIDAD',
      'Faltan los datos del productor del sistema informático (VERIFACTU_PRODUCTOR_NOMBRE y VERIFACTU_PRODUCTOR_NIF)'
    );
  }
  return bloque(t('SistemaInformatico'), [
    campo(t('NombreRazon'), limitar(sif.productor.nombreRazon, 120, 'nombre del productor')),
    campo(t('NIF'), sif.productor.nif),
    campo(t('NombreSistemaInformatico'), limitar(sif.nombre, 30, 'nombre del sistema informático')),
    campo(t('IdSistemaInformatico'), sif.idSistema),
    campo(t('Version'), sif.version),
    campo(t('NumeroInstalacion'), sif.numeroInstalacion),
    campo(t('TipoUsoPosibleSoloVerifactu'), siNo(sif.soloVerifactu)),
    campo(t('TipoUsoPosibleMultiOT'), siNo(sif.multiObligado)),
    campo(t('IndicadorMultiplesOT'), siNo(sif.multiplesObligadosAhora)),
  ]);
}

function limitar(valor: string, maximo: number, que: string): string {
  const texto = valor.trim();
  if (texto.length === 0 || texto.length > maximo) {
    throw new ErrorDominio('VALIDACION', `El ${que} debe tener entre 1 y ${maximo} caracteres`);
  }
  return texto;
}

/* -------------------------------------------------------------------------- */
/*  Registro de alta                                                          */
/* -------------------------------------------------------------------------- */

/** «IDFacturaRectificada» / «IDFacturaSustituida». */
function facturasReferidas(
  contenedor: 'FacturasRectificadas' | 'FacturasSustituidas',
  elemento: 'IDFacturaRectificada' | 'IDFacturaSustituida',
  referidas: FacturaRelacionada[]
): string {
  if (referidas.length === 0) return '';
  return bloque(
    t(contenedor),
    referidas.map((r) =>
      bloque(t(elemento), [
        campo(t('IDEmisorFactura'), r.referidaEmisorNif),
        campo(t('NumSerieFactura'), r.referidaNumSerie),
        campo(t('FechaExpedicionFactura'), formatearFecha(r.referidaFechaExpedicion)),
      ])
    )
  );
}

/**
 * «DetalleDesglose»: una fila por impuesto / régimen / calificación / tipo.
 *
 * Qué se informa depende de la calificación (validaciones de la AEAT):
 *   · Sujeta y no exenta (S1, S2) → tipo, base y cuota.
 *   · No sujeta (N1, N2)          → solo el importe no sujeto.
 *   · Exenta (E1..E6)             → solo la base; ni tipo ni cuota.
 * «ClaveRegimen» solo existe para IVA (01) e IGIC (03).
 */
function detalleDesglose(fila: FacturaDesglose): string {
  const exenta = fila.operacionExenta !== null;
  const noSujeta = fila.calificacionOperacion === 'N1' || fila.calificacionOperacion === 'N2';
  const conCuota = !exenta && !noSujeta;
  const conRegimen = fila.impuesto === '01' || fila.impuesto === '03';

  return bloque(t('DetalleDesglose'), [
    campo(t('Impuesto'), fila.impuesto),
    conRegimen && campo(t('ClaveRegimen'), fila.claveRegimen),
    exenta
      ? campo(t('OperacionExenta'), fila.operacionExenta)
      : campo(t('CalificacionOperacion'), fila.calificacionOperacion),
    conCuota && fila.tipoImpositivo !== null && campo(t('TipoImpositivo'), formatearImporte(fila.tipoImpositivo)),
    campo(t('BaseImponibleOimporteNoSujeto'), formatearImporte(fila.baseImponible)),
    conCuota && fila.cuotaRepercutida !== null && campo(t('CuotaRepercutida'), formatearImporte(fila.cuotaRepercutida)),
    conCuota &&
      fila.tipoRecargoEquivalencia !== null &&
      campo(t('TipoRecargoEquivalencia'), formatearImporte(fila.tipoRecargoEquivalencia)),
    conCuota &&
      fila.cuotaRecargoEquivalencia !== null &&
      campo(t('CuotaRecargoEquivalencia'), formatearImporte(fila.cuotaRecargoEquivalencia)),
  ]);
}

/** «Destinatarios»: NIF español o, en su defecto, el bloque «IDOtro». */
function destinatarios(factura: DatosRegistroAlta['factura']): string {
  if (!factura.destinatarioNombre) return '';
  let identificacion: string;
  if (factura.destinatarioNif) {
    identificacion = campo(t('NIF'), factura.destinatarioNif);
  } else if (factura.destinatarioIdOtroNumero && factura.destinatarioIdOtroTipo) {
    identificacion = bloque(t('IDOtro'), [
      campo(t('CodigoPais'), factura.destinatarioIdOtroCodigoPais),
      campo(t('IDType'), factura.destinatarioIdOtroTipo),
      campo(t('ID'), factura.destinatarioIdOtroNumero),
    ]);
  } else {
    return ''; // simplificada con nombre pero sin identificación fiscal: no hay destinatario que declarar
  }
  return bloque(t('Destinatarios'), [
    bloque(t('IDDestinatario'), [campo(t('NombreRazon'), factura.destinatarioNombre), identificacion]),
  ]);
}

/**
 * Serializa el «RegistroAlta» de una factura. El orden de los elementos es,
 * uno a uno, el de `RegistroFacturacionAltaType` en el XSD.
 */
export function serializarRegistroAlta(datos: DatosRegistroAlta): string {
  const { factura } = datos;
  if (!factura.emisorNif || !factura.numSerieFactura || !factura.fechaExpedicion || !factura.descripcionOperacion) {
    throw new ErrorDominio('INTEGRIDAD', 'La factura no tiene los datos mínimos del registro de alta', {
      facturaId: factura.id,
    });
  }
  if (datos.desglose.length < 1 || datos.desglose.length > 12) {
    throw new ErrorDominio(
      'VALIDACION',
      `El desglose fiscal debe tener entre 1 y 12 filas (tiene ${datos.desglose.length})`
    );
  }
  const esRectificativa = factura.tipoFactura.startsWith('R');
  const porSustitucion = esRectificativa && factura.tipoRectificativa === 'S';
  if (porSustitucion && (factura.baseRectificada === null || factura.cuotaRectificada === null)) {
    throw new ErrorDominio('VALIDACION', 'Una rectificativa por sustitución debe informar la base y la cuota rectificadas');
  }

  const rectificadas = datos.relacionadas.filter((r) => r.relacion === 'RECTIFICADA');
  const sustituidas = datos.relacionadas.filter((r) => r.relacion === 'SUSTITUIDA');

  return bloque(
    t('RegistroAlta'),
    [
      campo(t('IDVersion'), ID_VERSION),
      bloque(t('IDFactura'), [
        campo(t('IDEmisorFactura'), factura.emisorNif),
        campo(t('NumSerieFactura'), factura.numSerieFactura),
        campo(t('FechaExpedicionFactura'), formatearFecha(factura.fechaExpedicion)),
      ]),
      // «RefExterna»: el identificador interno del registro. La AEAT lo devuelve
      // en cada línea de la respuesta y permite casarla sin ambigüedad.
      campo(t('RefExterna'), datos.registroId),
      campo(t('NombreRazonEmisor'), datos.empresa.nombreRazon),
      datos.esSubsanacion && campo(t('Subsanacion'), 'S'),
      datos.rechazoPrevio !== 'N' && campo(t('RechazoPrevio'), datos.rechazoPrevio),
      campo(t('TipoFactura'), factura.tipoFactura),
      esRectificativa && campo(t('TipoRectificativa'), factura.tipoRectificativa),
      facturasReferidas('FacturasRectificadas', 'IDFacturaRectificada', rectificadas),
      facturasReferidas('FacturasSustituidas', 'IDFacturaSustituida', sustituidas),
      porSustitucion &&
        bloque(t('ImporteRectificacion'), [
          campo(t('BaseRectificada'), formatearImporte(factura.baseRectificada!)),
          campo(t('CuotaRectificada'), formatearImporte(factura.cuotaRectificada!)),
          factura.cuotaRecargoRectificado !== null &&
            campo(t('CuotaRecargoRectificado'), formatearImporte(factura.cuotaRecargoRectificado)),
        ]),
      factura.fechaOperacion && campo(t('FechaOperacion'), formatearFecha(factura.fechaOperacion)),
      campo(t('DescripcionOperacion'), limitar(factura.descripcionOperacion, 500, 'texto de la descripción de la operación')),
      destinatarios(factura),
      bloque(t('Desglose'), datos.desglose.map(detalleDesglose)),
      // Los dos importes que entran en la huella: mismo formateador, mismo texto.
      campo(t('CuotaTotal'), formatearImporte(factura.cuotaTotal)),
      campo(t('ImporteTotal'), formatearImporte(factura.importeTotal)),
      encadenamiento(datos.encadenamiento),
      sistemaInformatico(datos.sistemaInformatico),
      campo(t('FechaHoraHusoGenRegistro'), datos.fechaHoraHusoGen),
      campo(t('TipoHuella'), datos.tipoHuella),
      campo(t('Huella'), datos.huella),
    ],
    RAIZ_NS
  );
}

/* -------------------------------------------------------------------------- */
/*  Registro de anulación                                                     */
/* -------------------------------------------------------------------------- */

/** Serializa el «RegistroAnulacion» (orden de `RegistroFacturacionAnulacionType`). */
export function serializarRegistroAnulacion(datos: DatosRegistroAnulacion): string {
  return bloque(
    t('RegistroAnulacion'),
    [
      campo(t('IDVersion'), ID_VERSION),
      bloque(t('IDFactura'), [
        campo(t('IDEmisorFacturaAnulada'), datos.idEmisorFactura),
        campo(t('NumSerieFacturaAnulada'), datos.numSerieFactura),
        campo(t('FechaExpedicionFacturaAnulada'), formatearFecha(datos.fechaExpedicion)),
      ]),
      campo(t('RefExterna'), datos.registroId),
      // «SinRegistroPrevio» = S: se anula una factura cuyo registro de alta no consta en la AEAT.
      datos.sinRegistroPrevio && campo(t('SinRegistroPrevio'), 'S'),
      datos.rechazoPrevio && campo(t('RechazoPrevio'), 'S'),
      encadenamiento(datos.encadenamiento),
      sistemaInformatico(datos.sistemaInformatico),
      campo(t('FechaHoraHusoGenRegistro'), datos.fechaHoraHusoGen),
      campo(t('TipoHuella'), datos.tipoHuella),
      campo(t('Huella'), datos.huella),
    ],
    RAIZ_NS
  );
}
