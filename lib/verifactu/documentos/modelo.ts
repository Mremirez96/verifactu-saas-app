import type { Factura, FacturaDesglose, FacturaLinea, RegistroVerifactu } from '@/lib/db/schema';
import { contenidoQr, formatearImporte, type ContenidoQr, type EntornoAeat } from '../crypto';
import { ErrorDominio } from '../errores';
import { mencionSif } from './declaracion';
import { imagenQr, type ImagenQr } from './qr-svg';

/**
 * MODELO DE VISTA DEL DOCUMENTO
 *
 * Paso intermedio entre la base de datos y la plantilla: aquí se decide QUÉ
 * se imprime (y con qué formato de número y fecha); las plantillas solo
 * deciden DÓNDE. Es una función pura, así que el mismo modelo alimenta la
 * factura A4, el ticket y, el día que haga falta, un PDF generado en servidor.
 *
 * Regla de oro: el documento se construye con la FOTO FIJA guardada en la
 * factura (emisor y destinatario en el momento de emitir) y con los importes
 * almacenados. Nunca se recalcula ni se lee la ficha actual del cliente o de
 * la empresa: una factura emitida se imprime igual hoy que dentro de cinco años.
 */

export type FormatoDocumento = 'A4' | 'TICKET_80' | 'TICKET_58';

export type DatosDocumento = {
  factura: Factura;
  lineas: FacturaLinea[];
  desglose: FacturaDesglose[];
  /** Registro de alta de la factura; `null` mientras es un borrador. */
  registroAlta: RegistroVerifactu | null;
};

export type ModeloDocumento = {
  formato: FormatoDocumento;
  estado: Factura['estado'];
  titulo: 'Factura' | 'Factura simplificada';
  numSerieFactura: string | null;
  fechaExpedicion: string | null;
  fechaOperacion: string | null;
  emisor: { nombre: string; nif: string; domicilio: string | null };
  destinatario: { nombre: string; identificacion: string | null; domicilio: string | null } | null;
  lineas: Array<{
    descripcion: string;
    cantidad: string;
    precioUnitario: string;
    descuento: string | null;
    base: string;
    tipo: string;
    /** Base + cuota + recargo: lo que paga el cliente por esa línea. */
    importeConImpuestos: string;
  }>;
  desglose: Array<{
    concepto: string;
    base: string;
    cuota: string | null;
    recargo: { tipo: string; cuota: string } | null;
  }>;
  totales: {
    baseImponible: string;
    cuotaTotal: string;
    importeTotal: string;
    retencion: { porcentaje: string; importe: string } | null;
    totalAPagar: string;
  };
  /** Menciones legales que dependen del contenido (exenciones, inversión del sujeto pasivo...). */
  menciones: string[];
  observaciones: string | null;
  /** `null` en borradores: un borrador no lleva QR tributario. */
  qr: { contenido: ContenidoQr; imagen: ImagenQr; leyenda: string | null } | null;
  /** Pie: sistema informático y declaración responsable. */
  pie: string[];
};

/* ------------------------------ formato visual ----------------------------- */

const EUROS = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });
const NUMERO = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 4 });

/** Importe para LEER (1.234,50 €). El formato fiscal con punto solo va en huella, XML y QR. */
export const dinero = (valor: string | number) => EUROS.format(Number(valor));
const numero = (valor: string | number) => NUMERO.format(Number(valor));
const porcentaje = (valor: string | number) => `${numero(valor)} %`;
const fechaLarga = (iso: string) => iso.split('-').reverse().join('/');

/** Céntimos enteros, para sumar sin errores de coma flotante. */
function centimos(valor: string | null | undefined): number {
  if (!valor) return 0;
  const [, signo, enteros, decimales] = /^(-?)(\d+)\.(\d{2})$/.exec(formatearImporte(valor))!;
  return (signo ? -1 : 1) * (Number(enteros) * 100 + Number(decimales));
}

const IMPUESTOS: Record<string, string> = { '01': 'IVA', '02': 'IPSI', '03': 'IGIC', '05': 'Impuesto' };

/** Causas de exención (lista L10 del anexo; los artículos son de la Ley 37/1992 del IVA). */
const EXENCIONES_IVA: Record<string, string> = {
  E1: 'artículo 20',
  E2: 'artículo 21',
  E3: 'artículo 22',
  E4: 'artículos 23 y 24',
  E5: 'artículo 25',
};

type Fiscal = Pick<FacturaDesglose, 'impuesto' | 'claveRegimen' | 'calificacionOperacion' | 'operacionExenta' | 'tipoImpositivo'>;

function conceptoFiscal(f: Fiscal): string {
  const impuesto = IMPUESTOS[f.impuesto] ?? 'Impuesto';
  if (f.operacionExenta) return `${impuesto} exento`;
  if (f.calificacionOperacion === 'N1' || f.calificacionOperacion === 'N2') return `No sujeta a ${impuesto}`;
  return `${impuesto} ${porcentaje(f.tipoImpositivo ?? 0)}`;
}

function mencionesLegales(filas: Fiscal[]): string[] {
  const menciones = new Set<string>();
  for (const f of filas) {
    const impuesto = IMPUESTOS[f.impuesto] ?? 'impuesto';
    if (f.operacionExenta) {
      const articulo = f.impuesto === '01' ? EXENCIONES_IVA[f.operacionExenta] : undefined;
      menciones.add(
        articulo
          ? `Operación exenta de IVA (${articulo} de la Ley 37/1992).`
          : `Operación exenta de ${impuesto}.`
      );
    }
    if (f.calificacionOperacion === 'S2') menciones.add('Inversión del sujeto pasivo.');
    if (f.calificacionOperacion === 'N1' || f.calificacionOperacion === 'N2') {
      menciones.add(`Operación no sujeta a ${impuesto}.`);
    }
    if (f.claveRegimen === '07') menciones.add('Régimen especial del criterio de caja.');
  }
  return [...menciones];
}

/* ------------------------------ QR del registro ---------------------------- */

/**
 * El QR que se imprime es el del REGISTRO de alta, no uno calculado al vuelo.
 * Se reconstruye a partir de los datos de la factura y se exige que coincida
 * con la URL guardada: si no coinciden, el documento no se genera, porque el
 * papel diría una cosa y el registro otra.
 */
function qrDelRegistro(factura: Factura, registro: RegistroVerifactu, formato: FormatoDocumento) {
  if (!registro.qrUrl || !factura.emisorNif || !factura.numSerieFactura || !factura.fechaExpedicion) {
    throw new ErrorDominio('INTEGRIDAD', 'El registro de alta no tiene los datos del código QR', {
      facturaId: factura.id,
    });
  }
  const entorno: EntornoAeat = registro.qrUrl.startsWith('https://prewww2.aeat.es/') ? 'pruebas' : 'produccion';
  const contenido = contenidoQr({
    nif: factura.emisorNif,
    numSerieFactura: factura.numSerieFactura,
    fechaExpedicion: factura.fechaExpedicion,
    importeTotal: factura.importeTotal,
    modo: registro.modo,
    entorno,
  });
  if (contenido.url !== registro.qrUrl) {
    throw new ErrorDominio('INTEGRIDAD', 'El QR de la factura no coincide con el de su registro de facturación', {
      facturaId: factura.id,
      registroId: registro.id,
    });
  }

  return {
    contenido,
    // En el papel de 58 mm el símbolo va al mínimo (30 mm) para que quepa con su margen.
    imagen: imagenQr(contenido, { ladoSimboloMm: formato === 'TICKET_58' ? 30 : 32 }),
    // Frase obligatoria en VERI*FACTU (art. 20.1.b): la larga en A4, la corta en ticket.
    leyenda: contenido.leyenda ? (formato === 'A4' ? contenido.leyenda.larga : contenido.leyenda.corta) : null,
  };
}

/* --------------------------------- modelo ---------------------------------- */

/** Tipos que sabe representar esta versión: factura completa y simplificada. */
const TIPOS_SOPORTADOS = ['F1', 'F2'];

export function formatoPorDefecto(factura: Pick<Factura, 'tipoFactura'>): FormatoDocumento {
  return factura.tipoFactura === 'F2' ? 'TICKET_80' : 'A4';
}

export function construirModelo(datos: DatosDocumento, formato?: FormatoDocumento): ModeloDocumento {
  const { factura, registroAlta } = datos;

  if (!TIPOS_SOPORTADOS.includes(factura.tipoFactura)) {
    // Rectificativas y sustitutivas necesitan datos propios (factura rectificada,
    // motivo...) que aún no se representan: mejor negarse que imprimirlas a medias.
    throw new ErrorDominio(
      'VALIDACION',
      `La representación de facturas de tipo ${factura.tipoFactura} todavía no está disponible`
    );
  }

  const emitida = factura.estado !== 'BORRADOR';
  if (emitida && !registroAlta) {
    throw new ErrorDominio('INTEGRIDAD', 'La factura está emitida pero no tiene registro de alta', {
      facturaId: factura.id,
    });
  }
  const formatoFinal = formato ?? formatoPorDefecto(factura);
  const lineas = [...datos.lineas].sort((a, b) => a.orden - b.orden);

  const identificacion =
    factura.destinatarioNif ??
    (factura.destinatarioIdOtroNumero
      ? `${factura.destinatarioIdOtroCodigoPais ?? ''} ${factura.destinatarioIdOtroNumero}`.trim()
      : null);

  return {
    formato: formatoFinal,
    estado: factura.estado,
    titulo: factura.tipoFactura === 'F2' ? 'Factura simplificada' : 'Factura',
    numSerieFactura: factura.numSerieFactura,
    fechaExpedicion: factura.fechaExpedicion ? fechaLarga(factura.fechaExpedicion) : null,
    fechaOperacion:
      factura.fechaOperacion && factura.fechaOperacion !== factura.fechaExpedicion
        ? fechaLarga(factura.fechaOperacion)
        : null,
    emisor: {
      nombre: factura.emisorNombreRazon ?? '',
      nif: factura.emisorNif ?? '',
      domicilio: factura.emisorDomicilio,
    },
    destinatario: factura.destinatarioNombre
      ? { nombre: factura.destinatarioNombre, identificacion, domicilio: factura.destinatarioDomicilio }
      : null,
    lineas: lineas.map((l) => ({
      descripcion: l.descripcion,
      cantidad: numero(l.cantidad),
      precioUnitario: dinero(l.precioUnitario),
      descuento: Number(l.descuentoPorcentaje) > 0 ? porcentaje(l.descuentoPorcentaje) : null,
      base: dinero(l.baseLinea),
      tipo: conceptoFiscal(l),
      importeConImpuestos: dinero(
        (centimos(l.baseLinea) + centimos(l.cuota) + centimos(l.cuotaRecargoEquivalencia)) / 100
      ),
    })),
    desglose: datos.desglose.map((d) => ({
      concepto: conceptoFiscal(d),
      base: dinero(d.baseImponible),
      cuota: d.cuotaRepercutida !== null ? dinero(d.cuotaRepercutida) : null,
      recargo:
        d.cuotaRecargoEquivalencia !== null && centimos(d.cuotaRecargoEquivalencia) !== 0
          ? { tipo: porcentaje(d.tipoRecargoEquivalencia ?? 0), cuota: dinero(d.cuotaRecargoEquivalencia) }
          : null,
    })),
    totales: {
      baseImponible: dinero(factura.baseImponibleTotal),
      cuotaTotal: dinero(factura.cuotaTotal),
      importeTotal: dinero(factura.importeTotal),
      retencion:
        centimos(factura.retencionIrpfImporte) !== 0
          ? {
              porcentaje: porcentaje(factura.retencionIrpfPorcentaje ?? 0),
              importe: dinero(factura.retencionIrpfImporte),
            }
          : null,
      totalAPagar: dinero(factura.totalAPagar),
    },
    menciones: mencionesLegales(datos.desglose.length > 0 ? datos.desglose : lineas),
    observaciones: factura.observaciones,
    qr: emitida && registroAlta ? qrDelRegistro(factura, registroAlta, formatoFinal) : null,
    pie: mencionSif(),
  };
}
