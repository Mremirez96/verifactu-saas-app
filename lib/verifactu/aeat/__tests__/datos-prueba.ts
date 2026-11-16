import type { Factura, FacturaDesglose, FacturaRelacionada } from '@/lib/db/schema';
import { huellaRegistroAlta, huellaRegistroAnulacion, TIPO_HUELLA_SHA256 } from '../../crypto';
import type { DatosRegistroAlta, DatosRegistroAnulacion, DatosSistemaInformatico } from '../../registros/servicio';

/** Datos de prueba para los tests del generador de XML (sin base de datos). */

export const SIF: DatosSistemaInformatico = {
  idSistema: 'VF',
  nombre: 'Verifactu SaaS',
  version: '0.3.0',
  numeroInstalacion: 'VF-TEST-0001',
  productor: { nombreRazon: 'Productor de Pruebas, S.L.', nif: 'B12345674' },
  soloVerifactu: true,
  multiObligado: true,
  multiplesObligadosAhora: true,
};

export const EMPRESA = {
  id: '11111111-1111-4111-8111-111111111111',
  nif: '89890001K',
  nombreRazon: 'Peluquería Ñandú & Hijos <Centro>',
  modoVerifactu: 'VERIFACTU',
} as const;

export function factura(cambios: Partial<Factura> = {}): Factura {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    empresaId: EMPRESA.id,
    serieId: '33333333-3333-4333-8333-333333333333',
    numero: 12,
    numSerieFactura: 'F26-000012',
    tipoFactura: 'F1',
    tipoRectificativa: null,
    estado: 'EMITIDA',
    estadoCobro: 'PENDIENTE',
    fechaExpedicion: '2026-11-16',
    fechaOperacion: null,
    emitidaEn: new Date('2026-11-16T09:30:00Z'),
    anuladaEn: null,
    cobradaEn: null,
    clienteId: null,
    destinatarioNombre: 'Clínica Fisio "Sol" S.L.',
    destinatarioNif: 'B12345674',
    destinatarioIdOtroCodigoPais: null,
    destinatarioIdOtroTipo: null,
    destinatarioIdOtroNumero: null,
    destinatarioDomicilio: null,
    emisorNif: EMPRESA.nif,
    emisorNombreRazon: EMPRESA.nombreRazon,
    emisorDomicilio: null,
    descripcionOperacion: 'Servicios de peluquería & estética',
    baseImponibleTotal: '150.00',
    cuotaTotal: '21.00',
    importeTotal: '171.00',
    retencionIrpfPorcentaje: null,
    retencionIrpfImporte: '0.00',
    totalAPagar: '171.00',
    baseRectificada: null,
    cuotaRectificada: null,
    cuotaRecargoRectificado: null,
    observaciones: null,
    creadaPor: null,
    createdAt: new Date('2026-11-16T09:00:00Z'),
    updatedAt: new Date('2026-11-16T09:30:00Z'),
    ...cambios,
  };
}

export function desglose(cambios: Partial<FacturaDesglose> = {}): FacturaDesglose {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    empresaId: EMPRESA.id,
    facturaId: '22222222-2222-4222-8222-222222222222',
    impuesto: '01',
    claveRegimen: '01',
    calificacionOperacion: 'S1',
    operacionExenta: null,
    tipoImpositivo: '21.00',
    baseImponible: '100.00',
    cuotaRepercutida: '21.00',
    tipoRecargoEquivalencia: null,
    cuotaRecargoEquivalencia: null,
    ...cambios,
  };
}

export function relacionada(cambios: Partial<FacturaRelacionada> = {}): FacturaRelacionada {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    empresaId: EMPRESA.id,
    facturaId: '22222222-2222-4222-8222-222222222222',
    relacion: 'RECTIFICADA',
    facturaReferidaId: null,
    referidaEmisorNif: EMPRESA.nif,
    referidaNumSerie: 'F26-000003',
    referidaFechaExpedicion: '2026-10-01',
    ...cambios,
  };
}

const HUELLA_PREVIA = 'A'.repeat(64);
const FECHA_HORA = '2026-11-16T10:30:00+01:00';

/** «RegistroAlta» coherente: la huella es la que da el motor criptográfico. */
export function datosAlta(cambios: Partial<DatosRegistroAlta> = {}): DatosRegistroAlta {
  const f = cambios.factura ?? factura();
  const encadenamiento = cambios.encadenamiento ?? {
    esPrimerRegistro: false as const,
    registroAnterior: {
      idEmisorFactura: EMPRESA.nif,
      numSerieFactura: 'F26-000011',
      fechaExpedicion: '2026-11-15',
      huella: HUELLA_PREVIA,
    },
  };
  return {
    registroId: '66666666-6666-4666-8666-666666666666',
    empresa: EMPRESA,
    factura: f,
    desglose: [
      desglose(),
      desglose({ id: '44444444-4444-4444-8444-444444444445', calificacionOperacion: null, operacionExenta: 'E1', tipoImpositivo: null, baseImponible: '50.00', cuotaRepercutida: null }),
    ],
    relacionadas: [],
    esSubsanacion: false,
    rechazoPrevio: 'N',
    encadenamiento,
    sistemaInformatico: SIF,
    fechaHoraHusoGen: FECHA_HORA,
    tipoHuella: TIPO_HUELLA_SHA256,
    huella: huellaRegistroAlta({
      idEmisorFactura: f.emisorNif!,
      numSerieFactura: f.numSerieFactura!,
      fechaExpedicion: f.fechaExpedicion!,
      tipoFactura: f.tipoFactura,
      cuotaTotal: f.cuotaTotal,
      importeTotal: f.importeTotal,
      huellaAnterior: encadenamiento.esPrimerRegistro ? null : encadenamiento.registroAnterior.huella,
      fechaHoraHusoGen: FECHA_HORA,
    }),
    qrUrl: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K',
    ...cambios,
  };
}

export function datosAnulacion(cambios: Partial<DatosRegistroAnulacion> = {}): DatosRegistroAnulacion {
  return {
    registroId: '77777777-7777-4777-8777-777777777777',
    empresa: EMPRESA,
    idEmisorFactura: EMPRESA.nif,
    numSerieFactura: 'F26-000012',
    fechaExpedicion: '2026-11-16',
    sinRegistroPrevio: false,
    rechazoPrevio: false,
    encadenamiento: {
      esPrimerRegistro: false,
      registroAnterior: { idEmisorFactura: EMPRESA.nif, numSerieFactura: 'F26-000012', fechaExpedicion: '2026-11-16', huella: HUELLA_PREVIA },
    },
    sistemaInformatico: SIF,
    fechaHoraHusoGen: FECHA_HORA,
    tipoHuella: TIPO_HUELLA_SHA256,
    huella: huellaRegistroAnulacion({
      idEmisorFactura: EMPRESA.nif,
      numSerieFactura: 'F26-000012',
      fechaExpedicion: '2026-11-16',
      huellaAnterior: HUELLA_PREVIA,
      fechaHoraHusoGen: FECHA_HORA,
    }),
    ...cambios,
  };
}
