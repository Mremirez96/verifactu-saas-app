import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { XMLParser } from 'fast-xml-parser';
import { NS } from '../xml';
import { cuerpoSoap, erroresXsd, xsdDisponible } from './validar-xsd';

/**
 * SIMULADOR DE LOS SERVICIOS WEB DE LA AEAT (solo para tests)
 *
 * Un servidor HTTP local que habla el mismo SOAP que la AEAT: recibe mensajes
 * «RegFactuSistemaFacturacion» y contesta con «RespuestaRegFactuSistemaFacturacion»
 * o con un SOAP Fault, con la forma exacta de las respuestas reales. Así los
 * tests de integración ejercitan el cliente HTTP de verdad, sin red exterior.
 *
 * Cada petición consume un GUION de la lista (`encolar`); sin guiones aplica
 * `porDefecto` (aceptarlo todo). Como la AEAT, RECUERDA lo que ha registrado:
 * un registro que ya consta se rechaza por duplicado con «RegistroDuplicado».
 * Eso permite simular el caso difícil: la AEAT registra, pero la respuesta
 * se pierde.
 */

export type RegistroRecibido = {
  operacion: 'Alta' | 'Anulacion';
  nif: string;
  numSerie: string;
  fecha: string;
  refExterna: string | null;
  subsanacion: boolean;
  sinRegistroPrevio: boolean;
  firmado: boolean;
};

export type PeticionRecibida = {
  servicio: 'VerifactuSOAP' | 'RequerimientoSOAP';
  xml: string;
  /** `null` = cumple el XSD oficial; texto = errores; `undefined` = no se pudo validar. */
  erroresXsd: string | null | undefined;
  nifObligado: string;
  incidencia: boolean;
  refRequerimiento: string | null;
  finRequerimiento: boolean;
  registros: RegistroRecibido[];
};

export type Veredicto = {
  estado: 'Correcto' | 'AceptadoConErrores' | 'Incorrecto';
  codigo?: string;
  descripcion?: string;
};

export type Guion =
  /** La AEAT procesa el mensaje y responde registro a registro. */
  | { tipo: 'procesar'; veredicto?: (registro: RegistroRecibido) => Veredicto; tiempoEspera?: number; sinRefExterna?: boolean; retrasoMs?: number }
  /** La AEAT procesa y REGISTRA, pero la respuesta nunca llega (timeout en el cliente). */
  | { tipo: 'registrar-sin-responder' }
  /** La AEAT no contesta y no registra nada. */
  | { tipo: 'silencio' }
  /** Error HTTP sin cuerpo SOAP (balanceador, mantenimiento…). */
  | { tipo: 'http'; estado: number }
  /** SOAP Fault: rechazo del mensaje completo. */
  | { tipo: 'fault'; servidor: boolean; codigo?: string; mensaje: string }
  /** Corta la conexión sin responder. */
  | { tipo: 'cortar' };

const analizador = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseTagValue: false,
  isArray: (nombre) => nombre === 'RegistroFactura',
});

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class SimuladorAeat {
  readonly peticiones: PeticionRecibida[] = [];
  porDefecto: Guion = { tipo: 'procesar' };
  private guiones: Guion[] = [];
  /** Lo que «consta en la AEAT»: clave del registro → estado con el que se registró. */
  private registrados = new Map<string, { estado: 'Correcta' | 'AceptadaConErrores'; codigo?: string; descripcion?: string; peticion: number }>();
  private servidor: http.Server;
  private colgadas = new Set<http.ServerResponse>();
  private csv = 0;

  private constructor() {
    this.servidor = http.createServer((req, res) => this.atender(req, res));
  }

  static async iniciar(): Promise<SimuladorAeat> {
    const simulador = new SimuladorAeat();
    await new Promise<void>((listo) => simulador.servidor.listen(0, '127.0.0.1', listo));
    return simulador;
  }

  /** Programa el comportamiento de las siguientes peticiones, en orden. */
  encolar(...guiones: Guion[]): void {
    this.guiones.push(...guiones);
  }

  url(servicio: 'VerifactuSOAP' | 'RequerimientoSOAP'): string {
    const { port } = this.servidor.address() as AddressInfo;
    return `http://127.0.0.1:${port}/wlpl/TIKE-CONT/ws/SistemaFacturacion/${servicio}`;
  }

  /**
   * Hace constar un registro de alta en «la AEAT» sin que haya pasado por el
   * simulador: como si lo hubiera remitido otro programa del mismo obligado.
   */
  yaConsta(nif: string, numSerie: string): void {
    this.registrados.set([nif, numSerie, 'Alta', 'N'].join('|'), { estado: 'Correcta', peticion: 0 });
  }

  /** Peticiones recibidas de un obligado concreto. */
  de(nif: string): PeticionRecibida[] {
    return this.peticiones.filter((p) => p.nifObligado === nif);
  }

  async cerrar(): Promise<void> {
    for (const res of this.colgadas) res.destroy();
    await new Promise<void>((hecho) => this.servidor.close(() => hecho()));
  }

  /* ------------------------------------------------------------------------ */

  private atender(req: http.IncomingMessage, res: http.ServerResponse): void {
    const trozos: Buffer[] = [];
    req.on('data', (t: Buffer) => trozos.push(t));
    req.on('end', () => {
      const xml = Buffer.concat(trozos).toString('utf8');
      const peticion = this.leerPeticion(req.url ?? '', xml);
      this.peticiones.push(peticion);
      const guion = this.guiones.shift() ?? this.porDefecto;

      switch (guion.tipo) {
        case 'cortar':
          req.socket.destroy();
          return;
        case 'silencio':
          this.colgadas.add(res);
          return;
        case 'registrar-sin-responder':
          this.procesar(peticion, {}); // registra… y la respuesta se pierde
          this.colgadas.add(res);
          return;
        case 'http':
          res.writeHead(guion.estado, { 'Content-Type': 'text/html' }).end(`<html><body>Error ${guion.estado}</body></html>`);
          return;
        case 'fault':
          this.responder(res, 500, this.fault(guion.servidor, guion.codigo, guion.mensaje));
          return;
        case 'procesar': {
          const cuerpo = this.procesar(peticion, guion);
          if (guion.retrasoMs) setTimeout(() => this.responder(res, 200, cuerpo), guion.retrasoMs);
          else this.responder(res, 200, cuerpo);
          return;
        }
      }
    });
  }

  private responder(res: http.ServerResponse, estado: number, cuerpo: string): void {
    res.writeHead(estado, { 'Content-Type': 'text/xml; charset=UTF-8' }).end(cuerpo);
  }

  private leerPeticion(url: string, xml: string): PeticionRecibida {
    const mensaje = analizador.parse(xml)?.Envelope?.Body?.RegFactuSistemaFacturacion ?? {};
    const cabecera = mensaje.Cabecera ?? {};
    const registros: RegistroRecibido[] = (mensaje.RegistroFactura ?? []).map((rf: Record<string, any>) => {
      const alta = rf.RegistroAlta;
      const r = alta ?? rf.RegistroAnulacion ?? {};
      const id = r.IDFactura ?? {};
      return {
        operacion: alta ? 'Alta' : 'Anulacion',
        nif: id.IDEmisorFactura ?? id.IDEmisorFacturaAnulada ?? '',
        numSerie: id.NumSerieFactura ?? id.NumSerieFacturaAnulada ?? '',
        fecha: id.FechaExpedicionFactura ?? id.FechaExpedicionFacturaAnulada ?? '',
        refExterna: r.RefExterna ?? null,
        subsanacion: r.Subsanacion === 'S',
        sinRegistroPrevio: r.SinRegistroPrevio === 'S',
        firmado: r.Signature !== undefined,
      } satisfies RegistroRecibido;
    });

    let errores: string | null | undefined;
    try {
      errores = xsdDisponible ? erroresXsd(cuerpoSoap(xml), 'SuministroLR.xsd') : undefined;
    } catch (error) {
      errores = String(error);
    }

    return {
      servicio: url.endsWith('RequerimientoSOAP') ? 'RequerimientoSOAP' : 'VerifactuSOAP',
      xml,
      erroresXsd: errores,
      nifObligado: cabecera.ObligadoEmision?.NIF ?? '',
      incidencia: cabecera.RemisionVoluntaria?.Incidencia === 'S',
      refRequerimiento: cabecera.RemisionRequerimiento?.RefRequerimiento ?? null,
      finRequerimiento: cabecera.RemisionRequerimiento?.FinRequerimiento === 'S',
      registros,
    };
  }

  /** Procesa los registros como la AEAT y compone la respuesta. */
  private procesar(peticion: PeticionRecibida, guion: Partial<Extract<Guion, { tipo: 'procesar' }>>): string {
    const numPeticion = this.peticiones.length;
    const requerimiento = peticion.servicio === 'RequerimientoSOAP';
    let aceptados = 0;

    const lineas = peticion.registros.map((r) => {
      const clave = [r.nif, r.numSerie, r.operacion, r.subsanacion ? 'S' : 'N'].join('|');
      const previo = requerimiento ? undefined : this.registrados.get(clave);
      let veredicto: Veredicto;
      let duplicado = '';

      if (previo) {
        // Ya consta: rechazo por duplicado, informando de cómo está registrado.
        veredicto = { estado: 'Incorrecto', codigo: '3000', descripcion: 'Registro de facturación duplicado.' };
        duplicado =
          '<tikR:RegistroDuplicado>' +
          `<tik:IdPeticionRegistroDuplicado>${previo.peticion}</tik:IdPeticionRegistroDuplicado>` +
          `<tik:EstadoRegistroDuplicado>${previo.estado}</tik:EstadoRegistroDuplicado>` +
          (previo.codigo ? `<tik:CodigoErrorRegistro>${previo.codigo}</tik:CodigoErrorRegistro>` : '') +
          (previo.descripcion ? `<tik:DescripcionErrorRegistro>${esc(previo.descripcion)}</tik:DescripcionErrorRegistro>` : '') +
          '</tikR:RegistroDuplicado>';
      } else {
        veredicto = guion.veredicto?.(r) ?? { estado: 'Correcto' };
        if (veredicto.estado !== 'Incorrecto') {
          aceptados++;
          this.registrados.set(clave, {
            estado: veredicto.estado === 'Correcto' ? 'Correcta' : 'AceptadaConErrores',
            codigo: veredicto.codigo,
            descripcion: veredicto.descripcion,
            peticion: numPeticion,
          });
        }
      }

      return (
        '<tikR:RespuestaLinea><tikR:IDFactura>' +
        `<tik:IDEmisorFactura>${r.nif}</tik:IDEmisorFactura>` +
        `<tik:NumSerieFactura>${esc(r.numSerie)}</tik:NumSerieFactura>` +
        `<tik:FechaExpedicionFactura>${r.fecha}</tik:FechaExpedicionFactura>` +
        '</tikR:IDFactura><tikR:Operacion>' +
        `<tik:TipoOperacion>${r.operacion}</tik:TipoOperacion>` +
        (r.operacion === 'Alta' ? `<tik:Subsanacion>${r.subsanacion ? 'S' : 'N'}</tik:Subsanacion>` : '') +
        '</tikR:Operacion>' +
        (r.refExterna && !guion.sinRefExterna ? `<tikR:RefExterna>${r.refExterna}</tikR:RefExterna>` : '') +
        `<tikR:EstadoRegistro>${veredicto.estado}</tikR:EstadoRegistro>` +
        (veredicto.codigo ? `<tikR:CodigoErrorRegistro>${veredicto.codigo}</tikR:CodigoErrorRegistro>` : '') +
        (veredicto.descripcion ? `<tikR:DescripcionErrorRegistro>${esc(veredicto.descripcion)}</tikR:DescripcionErrorRegistro>` : '') +
        duplicado +
        '</tikR:RespuestaLinea>'
      );
    });

    const estadoEnvio =
      aceptados === peticion.registros.length && !lineas.some((l) => l.includes('AceptadoConErrores'))
        ? 'Correcto'
        : aceptados === 0
          ? 'Incorrecto'
          : 'ParcialmenteCorrecto';
    // El CSV solo se genera si al menos un registro se acepta.
    const acuse =
      aceptados > 0
        ? `<tikR:CSV>A-SIMULADOR${String(++this.csv).padStart(6, '0')}</tikR:CSV>` +
          `<tikR:DatosPresentacion><tik:NIFPresentador>${peticion.nifObligado}</tik:NIFPresentador>` +
          `<tik:TimestampPresentacion>${new Date().toISOString().slice(0, 19)}+00:00</tik:TimestampPresentacion></tikR:DatosPresentacion>`
        : '';

    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<env:Envelope xmlns:env="${NS.soapenv}"><env:Header/><env:Body Id="Body">` +
      `<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="${NS.respuesta}" xmlns:tik="${NS.sum1}">` +
      acuse +
      `<tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>Simulador</tik:NombreRazon><tik:NIF>${peticion.nifObligado}</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>` +
      `<tikR:TiempoEsperaEnvio>${guion.tiempoEspera ?? 60}</tikR:TiempoEsperaEnvio>` +
      `<tikR:EstadoEnvio>${estadoEnvio}</tikR:EstadoEnvio>` +
      lineas.join('') +
      '</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>'
    );
  }

  private fault(servidor: boolean, codigo: string | undefined, mensaje: string): string {
    return (
      '<?xml version="1.0" encoding="UTF-8"?>' +
      `<env:Envelope xmlns:env="${NS.soapenv}"><env:Body><env:Fault>` +
      `<faultcode>env:${servidor ? 'Server' : 'Client'}</faultcode>` +
      `<faultstring>${codigo ? `Codigo[${codigo}].` : ''}${esc(mensaje)}</faultstring>` +
      '</env:Fault></env:Body></env:Envelope>'
    );
  }
}
