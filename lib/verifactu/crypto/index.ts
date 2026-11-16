/**
 * Módulo criptográfico VERI*FACTU.
 *
 * Todo lo que hay aquí es PURO (sin base de datos, reloj ni red):
 *   formato.ts → normalización de importes, fechas y fecha-hora con huso
 *   huella.ts  → cadena de texto normalizada + SHA-256 (alta y anulación)
 *   cadena.ts  → verificación de la cadena y tipificación de anomalías
 *   qr.ts      → contenido del código QR tributario
 *
 * La parte con estado (bloqueo de la cadena, inserción del registro) vive en
 * lib/verifactu/registros/ y usa este módulo.
 */
export * from './formato';
export * from './huella';
export * from './cadena';
export * from './qr';
