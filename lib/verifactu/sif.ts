import type { EntornoAeat } from './crypto/qr';
import { ErrorDominio } from './errores';

/**
 * Identidad del Sistema Informático de Facturación (bloque «SistemaInformatico»
 * del anexo de la Orden HAC/1177/2024). Estos valores viajan en cada registro
 * y deben coincidir con los de la declaración responsable del productor.
 *
 * PENDIENTE DEL PRODUCTOR: `idSistema` y `nombre` son provisionales.
 */
export const SISTEMA_INFORMATICO = {
  /** «IdSistemaInformatico» (2 caracteres): distingue este SIF de otros del mismo productor. */
  idSistema: 'VF',
  /** «NombreSistemaInformatico» (máx. 30). */
  nombre: 'Verifactu SaaS',
  /** «Version» (máx. 50). Debe cambiar con cada versión declarada. */
  version: '0.3.0',
} as const;

/**
 * Características del SIF que deben constar en la declaración responsable
 * (art. 15.1 de la Orden, letras d a g). Son afirmaciones sobre ESTA versión
 * del código: si el código cambia, hay que revisarlas.
 */
export const CARACTERISTICAS_SIF = {
  /** Letra d): componentes y breve descripción. */
  componentes:
    'Aplicación web (Next.js sobre Node.js) y base de datos PostgreSQL, ofrecidas como servicio en la nube. ' +
    'No incluye componentes hardware.',
  descripcion:
    'Sistema de facturación para autónomos y pymes: expide facturas completas y simplificadas, genera por cada una ' +
    'su registro de facturación con huella encadenada y código QR, e impide su alteración o borrado.',
  /**
   * Letra e): en esta versión el alta y la emisión en modo NO VERI*FACTU están
   * bloqueadas en el código (empresas/servicio.ts y registros/servicio.ts).
   * Cuando se habiliten, este valor pasa a `false` y hay que informar la letra g).
   */
  soloVerifactu: true,
  /** Letra f): una misma instalación da servicio a varios obligados tributarios. */
  multiObligado: true,
  /** Letra g): tipos de firma en modo NO VERI*FACTU. */
  tiposFirma: null as string | null,
} as const;

/**
 * Datos del PRODUCTOR y de la suscripción de la declaración responsable
 * (art. 15.1, letras h, i, j y l). Son datos de quien fabrica el software, no
 * de quien lo usa; se leen del entorno para no dejar un NIF escrito en el
 * código fuente. Mientras falte alguno, la declaración se muestra como
 * INCOMPLETA: no se inventa ninguno.
 */
export function datosProductor() {
  const leer = (nombre: string) => process.env[nombre]?.trim() || null;
  return {
    nombreRazon: leer('VERIFACTU_PRODUCTOR_NOMBRE'),
    nif: leer('VERIFACTU_PRODUCTOR_NIF'),
    direccion: leer('VERIFACTU_PRODUCTOR_DIRECCION'),
    /** Día, mes y año, en ese orden (p. ej. "16 de noviembre de 2026"). */
    fechaDeclaracion: leer('VERIFACTU_DECLARACION_FECHA'),
    /** Localidad y país, en ese orden (p. ej. "Madrid, España"). */
    lugarDeclaracion: leer('VERIFACTU_DECLARACION_LUGAR'),
  };
}

/**
 * Entorno de la AEAT al que apuntan el QR y (más adelante) los envíos.
 * En producción hay que declararlo: un QR de pruebas en una factura real, o
 * al revés, no cotejaría, y eso no puede depender de un valor por defecto.
 */
export function entornoAeat(): EntornoAeat {
  const valor = process.env.VERIFACTU_AEAT_ENTORNO;
  if (valor === 'produccion' || valor === 'pruebas') return valor;
  if (valor) {
    throw new ErrorDominio('INTEGRIDAD', `VERIFACTU_AEAT_ENTORNO no válido: "${valor}" (produccion | pruebas)`);
  }
  if (process.env.NODE_ENV === 'production') {
    throw new ErrorDominio('INTEGRIDAD', 'Falta VERIFACTU_AEAT_ENTORNO (produccion | pruebas)');
  }
  return 'pruebas';
}
