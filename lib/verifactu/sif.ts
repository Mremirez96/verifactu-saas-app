import type { EntornoAeat } from './crypto/qr';
import { ErrorDominio } from './errores';

/**
 * Identidad del Sistema Informático de Facturación (bloque «SistemaInformatico»
 * del anexo de la Orden HAC/1177/2024). Estos valores viajan en cada registro
 * y deben coincidir con los de la declaración responsable del productor.
 *
 * PENDIENTE DEL PRODUCTOR: `idSistema` y `nombre` son provisionales; el NIF y
 * la razón social del productor se añadirán con el generador de XML.
 */
export const SISTEMA_INFORMATICO = {
  /** «IdSistemaInformatico» (2 caracteres): distingue este SIF de otros del mismo productor. */
  idSistema: 'VF',
  /** «NombreSistemaInformatico» (máx. 30). */
  nombre: 'Verifactu SaaS',
  /** «Version» (máx. 50). Debe cambiar con cada versión declarada. */
  version: '0.2.0',
} as const;

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
