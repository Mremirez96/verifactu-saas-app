import { readFileSync } from 'node:fs';
import type { EntornoAeat } from '../crypto';
import { ErrorDominio } from '../errores';
import { entornoAeat } from '../sif';

/**
 * Configuración de la conexión con los servicios web de la AEAT.
 *
 * Los servicios son SOAP 1.1 sobre HTTPS con autenticación por CERTIFICADO
 * ELECTRÓNICO de cliente (TLS mutuo). Quien se identifica con el certificado
 * tiene que ser el propio obligado tributario, un apoderado suyo para este
 * trámite o un colaborador social; si no, la AEAT rechaza el envío completo.
 * En un SaaS lo habitual es un certificado del prestador del servicio con
 * colaboración social o apoderamiento de cada cliente.
 */

export type TipoCertificado = 'certificado' | 'sello';
export type ServicioAeat = 'VOLUNTARIA' | 'REQUERIMIENTO';

/**
 * Puertos del WSDL oficial «SistemaFacturacion.wsdl».
 *   · Remisión voluntaria «VERI*FACTU»  → …/VerifactuSOAP
 *   · Respuesta a requerimiento          → …/RequerimientoSOAP
 * Hay un host distinto según el certificado sea de persona/representante
 * (www1) o de SELLO electrónico (www10). Usar el host equivocado hace fallar
 * la negociación TLS.
 */
const HOSTS: Record<EntornoAeat, Record<TipoCertificado, string>> = {
  produccion: {
    certificado: 'https://www1.agenciatributaria.gob.es',
    sello: 'https://www10.agenciatributaria.gob.es',
  },
  pruebas: {
    certificado: 'https://prewww1.aeat.es',
    sello: 'https://prewww10.aeat.es',
  },
};

const RUTAS: Record<ServicioAeat, string> = {
  VOLUNTARIA: '/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP',
  REQUERIMIENTO: '/wlpl/TIKE-CONT/ws/SistemaFacturacion/RequerimientoSOAP',
};

export function endpointAeat(entorno: EntornoAeat, certificado: TipoCertificado, servicio: ServicioAeat): string {
  return HOSTS[entorno][certificado] + RUTAS[servicio];
}

/** Certificado de cliente para el TLS mutuo. */
export type CredencialesAeat = {
  /** Almacén PKCS#12 (.p12 / .pfx) con el certificado y su clave privada. */
  pfx: Buffer;
  contrasena: string;
};

export type ConfiguracionAeat = {
  entorno: EntornoAeat;
  tipoCertificado: TipoCertificado;
  endpoints: Record<ServicioAeat, string>;
  /** `null` solo es admisible contra un simulador (tests). */
  credenciales: CredencialesAeat | null;
  /** Tiempo máximo de espera de la respuesta, en milisegundos. */
  timeoutMs: number;
};

const TIMEOUT_POR_DEFECTO_MS = 30_000;

/**
 * Lee la configuración del entorno. Variables:
 *
 *   VERIFACTU_AEAT_ENTORNO            pruebas | produccion (ya usada por el QR)
 *   VERIFACTU_AEAT_TIPO_CERTIFICADO   certificado (por defecto) | sello
 *   VERIFACTU_AEAT_CERT_PFX_BASE64    el .p12 en base64 (recomendado en la nube), o bien
 *   VERIFACTU_AEAT_CERT_PFX_RUTA      ruta a un fichero .p12 en el servidor
 *   VERIFACTU_AEAT_CERT_CONTRASENA    contraseña del .p12
 *   VERIFACTU_AEAT_TIMEOUT_MS         por defecto 30000
 *
 * El certificado NUNCA se guarda en el repositorio ni en la base de datos:
 * vive en el gestor de secretos del despliegue.
 */
export function configuracionAeat(): ConfiguracionAeat {
  const entorno = entornoAeat();
  const tipo = (process.env.VERIFACTU_AEAT_TIPO_CERTIFICADO ?? 'certificado').trim();
  if (tipo !== 'certificado' && tipo !== 'sello') {
    throw new ErrorDominio('INTEGRIDAD', `VERIFACTU_AEAT_TIPO_CERTIFICADO no válido: "${tipo}" (certificado | sello)`);
  }

  const timeout = Number(process.env.VERIFACTU_AEAT_TIMEOUT_MS ?? TIMEOUT_POR_DEFECTO_MS);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 300_000) {
    throw new ErrorDominio('INTEGRIDAD', 'VERIFACTU_AEAT_TIMEOUT_MS debe estar entre 1000 y 300000');
  }

  return {
    entorno,
    tipoCertificado: tipo,
    endpoints: {
      VOLUNTARIA: endpointAeat(entorno, tipo, 'VOLUNTARIA'),
      REQUERIMIENTO: endpointAeat(entorno, tipo, 'REQUERIMIENTO'),
    },
    credenciales: leerCredenciales(),
    timeoutMs: timeout,
  };
}

function leerCredenciales(): CredencialesAeat | null {
  const base64 = process.env.VERIFACTU_AEAT_CERT_PFX_BASE64?.trim();
  const ruta = process.env.VERIFACTU_AEAT_CERT_PFX_RUTA?.trim();
  if (!base64 && !ruta) return null;

  let pfx: Buffer;
  try {
    pfx = base64 ? Buffer.from(base64, 'base64') : readFileSync(ruta!);
  } catch {
    // No se incluye el error original: podría arrastrar rutas o contenido sensible.
    throw new ErrorDominio('INTEGRIDAD', 'No se ha podido leer el certificado de cliente para la AEAT');
  }
  if (pfx.length === 0) {
    throw new ErrorDominio('INTEGRIDAD', 'El certificado de cliente para la AEAT está vacío');
  }
  return { pfx, contrasena: process.env.VERIFACTU_AEAT_CERT_CONTRASENA ?? '' };
}
