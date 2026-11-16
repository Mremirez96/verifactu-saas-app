import http from 'node:http';
import https from 'node:https';
import type { CredencialesAeat } from './config';

/**
 * TRANSPORTE HTTP DE LOS MENSAJES SOAP
 *
 * Una única responsabilidad: entregar un XML a una URL y devolver lo que
 * conteste el servidor (código HTTP y cuerpo), sin interpretarlo. La cola
 * recibe el transporte como dependencia, de modo que los tests pueden usar el
 * real contra un simulador local de la AEAT.
 *
 * LO QUE IMPORTA DE UN FALLO: ¿pudo llegar el mensaje a la AEAT?
 *   · Si la conexión ni siquiera se abrió (sin cobertura, DNS, puerto
 *     cerrado), la AEAT no ha visto nada: `entregaIncierta = false`.
 *   · Si el mensaje salió completo y lo que falló fue la respuesta (timeout,
 *     conexión cortada), la AEAT PUEDE haberlo registrado: `entregaIncierta =
 *     true`. Al reintentar, la AEAT contestará «registro duplicado» y la cola
 *     sabrá que eso es una confirmación y no un rechazo (ver respuesta.ts).
 */

export type PeticionSoap = {
  url: string;
  /** Sobre SOAP completo, en UTF-8. */
  xml: string;
  timeoutMs: number;
};

export type RespuestaHttp = {
  estado: number;
  cuerpo: string;
};

export type Transporte = (peticion: PeticionSoap) => Promise<RespuestaHttp>;

export class ErrorTransporte extends Error {
  /** Código del sistema (ECONNREFUSED, ENOTFOUND…) o TIMEOUT / RESPUESTA_DEMASIADO_GRANDE. */
  readonly codigo: string;
  /** TRUE = el mensaje se envió entero y no se sabe si la AEAT lo procesó. */
  readonly entregaIncierta: boolean;

  constructor(codigo: string, mensaje: string, entregaIncierta: boolean) {
    super(mensaje);
    this.name = 'ErrorTransporte';
    this.codigo = codigo;
    this.entregaIncierta = entregaIncierta;
  }
}

/** Una respuesta con 1.000 líneas ronda 1 MB; por encima de esto algo va mal. */
const TAMANO_MAXIMO_RESPUESTA = 16 * 1024 * 1024;

/**
 * Crea el transporte real.
 *
 * Con credenciales se usa TLS mutuo: el certificado del almacén PKCS#12 se
 * presenta al servidor de la AEAT, cuyo certificado se valida a su vez contra
 * las autoridades del sistema (la verificación NO se desactiva nunca).
 * HTTP sin cifrar solo se admite fuera de producción, para el simulador.
 */
export function crearTransporteHttps(credenciales: CredencialesAeat | null): Transporte {
  const agenteHttps = new https.Agent({
    keepAlive: true,
    maxSockets: 8,
    ...(credenciales ? { pfx: credenciales.pfx, passphrase: credenciales.contrasena } : {}),
  });
  const agenteHttp = new http.Agent({ keepAlive: false });

  return ({ url, xml, timeoutMs }) =>
    new Promise<RespuestaHttp>((resolver, rechazar) => {
      const destino = new URL(url);
      const cifrado = destino.protocol === 'https:';
      if (!cifrado && (destino.protocol !== 'http:' || process.env.NODE_ENV === 'production')) {
        rechazar(new ErrorTransporte('URL_NO_VALIDA', 'La AEAT solo se contacta por HTTPS', false));
        return;
      }
      if (cifrado && !credenciales && process.env.NODE_ENV === 'production') {
        rechazar(new ErrorTransporte('SIN_CERTIFICADO', 'Falta el certificado de cliente para la AEAT', false));
        return;
      }

      const cuerpo = Buffer.from(xml, 'utf8');
      let enviadoCompleto = false;
      let terminado = false;

      const fallar = (codigo: string, mensaje: string) => {
        if (terminado) return;
        terminado = true;
        rechazar(new ErrorTransporte(codigo, mensaje, enviadoCompleto));
      };

      const peticion = (cifrado ? https : http).request(
        destino,
        {
          method: 'POST',
          agent: cifrado ? agenteHttps : agenteHttp,
          headers: {
            // SOAP 1.1: text/xml y cabecera SOAPAction (vacía, como declara el WSDL).
            'Content-Type': 'text/xml; charset=utf-8',
            'Content-Length': cuerpo.length,
            SOAPAction: '""',
            Accept: 'text/xml',
          },
        },
        (respuesta) => {
          const trozos: Buffer[] = [];
          let recibido = 0;
          respuesta.on('data', (trozo: Buffer) => {
            recibido += trozo.length;
            if (recibido > TAMANO_MAXIMO_RESPUESTA) {
              peticion.destroy();
              fallar('RESPUESTA_DEMASIADO_GRANDE', 'La respuesta de la AEAT supera el tamaño máximo admitido');
              return;
            }
            trozos.push(trozo);
          });
          respuesta.on('error', (error: NodeJS.ErrnoException) =>
            fallar(error.code ?? 'ERROR_DE_RED', `Respuesta interrumpida: ${error.message}`)
          );
          respuesta.on('end', () => {
            if (terminado) return;
            // `end` también se emite si el servidor corta a medias: en ese caso no hay respuesta fiable.
            if (!respuesta.complete) {
              fallar('RESPUESTA_INCOMPLETA', 'La AEAT cerró la conexión antes de terminar su respuesta');
              return;
            }
            terminado = true;
            resolver({ estado: respuesta.statusCode ?? 0, cuerpo: Buffer.concat(trozos).toString('utf8') });
          });
        }
      );

      // A partir de aquí el mensaje ha salido entero hacia la AEAT.
      peticion.on('finish', () => {
        enviadoCompleto = true;
      });
      peticion.setTimeout(timeoutMs, () => {
        peticion.destroy();
        fallar('TIMEOUT', `Sin respuesta de la AEAT en ${timeoutMs} ms`);
      });
      peticion.on('error', (error: NodeJS.ErrnoException) =>
        fallar(error.code ?? 'ERROR_DE_RED', `No se ha podido contactar con la AEAT: ${error.message}`)
      );

      peticion.end(cuerpo);
    });
}
