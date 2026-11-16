/**
 * Mensajes SOAP de remisión y lectura de las respuestas de la AEAT.  →  pnpm test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ErrorDominio } from '../../errores';
import { serializarRegistroAlta, serializarRegistroAnulacion } from '../registro-xml';
import {
  clasificarErrorDeEnvio,
  clasificarRespuestaHttp,
  desenlaceDeLinea,
  emparejarLineas,
} from '../respuesta';
import { construirMensajeRemision, interpretarRespuesta, type LineaRespuesta } from '../soap';
import { ErrorTransporte } from '../transporte';
import { NS } from '../xml';
import { datosAlta, datosAnulacion, EMPRESA } from './datos-prueba';
import { cuerpoSoap, erroresXsd, xsdDisponible } from './validar-xsd';

const omitir = xsdDisponible ? false : 'xmllint no está instalado: no se puede validar contra el XSD';
const obligado = { nombreRazon: EMPRESA.nombreRazon, nif: EMPRESA.nif };
const registros = [serializarRegistroAlta(datosAlta()), serializarRegistroAnulacion(datosAnulacion())];

describe('Mensaje de remisión', () => {
  it('cumple el XSD con alta y anulación en el mismo envío', { skip: omitir }, () => {
    const sobre = construirMensajeRemision({ obligado, remision: { tipo: 'VOLUNTARIA', incidencia: false } }, registros);
    assert.equal(erroresXsd(cuerpoSoap(sobre), 'SuministroLR.xsd'), null);
    // Y el validador no es complaciente: un registro mal formado se detecta.
    assert.match(erroresXsd(cuerpoSoap(sobre.replace('<sum1:TipoHuella>01</sum1:TipoHuella>', '')), 'SuministroLR.xsd') ?? '', /Huella/);
  });

  it('cumple el XSD con incidencia, renuncia a VERI*FACTU, representante y requerimiento', { skip: omitir }, () => {
    const variantes = [
      construirMensajeRemision({ obligado, remision: { tipo: 'VOLUNTARIA', incidencia: true, fechaFinVerifactu: '2026-12-31' } }, registros),
      construirMensajeRemision(
        { obligado, representante: { nombreRazon: 'Asesoría Pérez', nif: 'B12345674' }, remision: { tipo: 'VOLUNTARIA', incidencia: true } },
        registros
      ),
      construirMensajeRemision({ obligado, remision: { tipo: 'REQUERIMIENTO', refRequerimiento: 'REQ-2026-000123', finRequerimiento: true } }, registros),
    ];
    for (const [i, sobre] of variantes.entries()) {
      assert.equal(erroresXsd(cuerpoSoap(sobre), 'SuministroLR.xsd'), null, `variante ${i}`);
    }
  });

  it('declara la incidencia solo cuando la hay, y los registros viajan sin tocar', () => {
    const normal = construirMensajeRemision({ obligado, remision: { tipo: 'VOLUNTARIA', incidencia: false } }, registros);
    const conIncidencia = construirMensajeRemision({ obligado, remision: { tipo: 'VOLUNTARIA', incidencia: true } }, registros);

    assert.ok(normal.startsWith('<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope'));
    assert.ok(!normal.includes('RemisionVoluntaria'));
    assert.ok(conIncidencia.includes('<sum1:RemisionVoluntaria><sum1:Incidencia>S</sum1:Incidencia></sum1:RemisionVoluntaria>'));
    // Cada registro se incrusta literalmente, tal como está guardado (su huella no se recalcula).
    for (const registro of registros) assert.ok(normal.includes(`<sum:RegistroFactura>${registro}</sum:RegistroFactura>`));
    assert.ok(normal.indexOf('RegistroAlta') < normal.indexOf('RegistroAnulacion'), 'se respeta el orden');
    // El nombre del obligado va escapado.
    assert.ok(normal.includes('<sum1:NombreRazon>Peluquería Ñandú &amp; Hijos &lt;Centro&gt;</sum1:NombreRazon>'));
  });

  it('en un requerimiento la referencia va siempre y «FinRequerimiento» solo en el último mensaje', () => {
    const intermedio = construirMensajeRemision({ obligado, remision: { tipo: 'REQUERIMIENTO', refRequerimiento: 'REQ1', finRequerimiento: false } }, registros);
    const ultimo = construirMensajeRemision({ obligado, remision: { tipo: 'REQUERIMIENTO', refRequerimiento: 'REQ1', finRequerimiento: true } }, registros);
    assert.ok(intermedio.includes('<sum1:RefRequerimiento>REQ1</sum1:RefRequerimiento>') && !intermedio.includes('FinRequerimiento'));
    assert.ok(ultimo.includes('<sum1:FinRequerimiento>S</sum1:FinRequerimiento>'));
    assert.ok(!ultimo.includes('RemisionVoluntaria'));
  });

  it('admite de 1 a 1.000 registros y quita la declaración XML de los registros incrustados', () => {
    const cabecera = { obligado, remision: { tipo: 'VOLUNTARIA' as const, incidencia: false } };
    const es = (patron: RegExp) => (e: unknown) => e instanceof ErrorDominio && patron.test(e.message);
    assert.throws(() => construirMensajeRemision(cabecera, []), es(/entre 1 y 1000/));
    assert.throws(() => construirMensajeRemision(cabecera, Array(1001).fill(registros[0])), es(/entre 1 y 1000/));
    assert.equal(construirMensajeRemision(cabecera, Array(1000).fill(registros[0])).split('<sum:RegistroFactura>').length - 1, 1000);
    assert.throws(
      () => construirMensajeRemision({ obligado, remision: { tipo: 'REQUERIMIENTO', refRequerimiento: 'x'.repeat(19), finRequerimiento: true } }, registros),
      es(/18 caracteres/)
    );
    const conDeclaracion = construirMensajeRemision(cabecera, [`<?xml version="1.0" encoding="UTF-8"?>\n${registros[0]}`]);
    assert.equal(conDeclaracion.split('<?xml').length - 1, 1);
  });
});

/* --------------------------- respuestas de la AEAT -------------------------- */

const sobreRespuesta = (contenido: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="${NS.soapenv}"><env:Header/><env:Body Id="Body">` +
  `<tikR:RespuestaRegFactuSistemaFacturacion xmlns:tikR="${NS.respuesta}" xmlns:tik="${NS.sum1}">${contenido}` +
  '</tikR:RespuestaRegFactuSistemaFacturacion></env:Body></env:Envelope>';

const cabeceraRespuesta =
  '<tikR:Cabecera><tik:ObligadoEmision><tik:NombreRazon>X</tik:NombreRazon><tik:NIF>89890001K</tik:NIF></tik:ObligadoEmision></tikR:Cabecera>';

const lineaXml = (numSerie: string, estado: string, extra = '', operacion = 'Alta', refExterna = '') =>
  `<tikR:RespuestaLinea><tikR:IDFactura><tik:IDEmisorFactura>89890001K</tik:IDEmisorFactura><tik:NumSerieFactura>${numSerie}</tik:NumSerieFactura>` +
  '<tik:FechaExpedicionFactura>16-11-2026</tik:FechaExpedicionFactura></tikR:IDFactura>' +
  `<tikR:Operacion><tik:TipoOperacion>${operacion}</tik:TipoOperacion></tikR:Operacion>` +
  (refExterna ? `<tikR:RefExterna>${refExterna}</tikR:RefExterna>` : '') +
  `<tikR:EstadoRegistro>${estado}</tikR:EstadoRegistro>${extra}</tikR:RespuestaLinea>`;

describe('Lectura de la respuesta de la AEAT', () => {
  it('envío correcto: CSV, presentación, tiempo de espera y una línea por registro', () => {
    const xml = sobreRespuesta(
      '<tikR:CSV>A-86U4KHPACUMVZE</tikR:CSV>' +
        '<tikR:DatosPresentacion><tik:NIFPresentador>B12345674</tik:NIFPresentador><tik:TimestampPresentacion>2026-11-16T10:31:02+01:00</tik:TimestampPresentacion></tikR:DatosPresentacion>' +
        cabeceraRespuesta +
        '<tikR:TiempoEsperaEnvio>60</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>' +
        lineaXml('F26-000012', 'Correcto', '', 'Alta', 'id-1') +
        lineaXml('F26-000012', 'Correcto', '', 'Anulacion')
    );
    // La respuesta de ejemplo es, a su vez, válida para el XSD de respuestas.
    if (xsdDisponible) {
      const cuerpo = /<env:Body[^>]*>([\s\S]*)<\/env:Body>/.exec(xml)![1];
      assert.equal(erroresXsd(cuerpo, 'RespuestaSuministro.xsd'), null);
    }

    const r = interpretarRespuesta(xml);
    assert.ok(r?.tipo === 'RESPUESTA');
    assert.deepEqual(
      { csv: r.csv, nif: r.nifPresentador, ts: r.timestampPresentacion, t: r.tiempoEsperaSeg, estado: r.estadoEnvio, n: r.lineas.length },
      { csv: 'A-86U4KHPACUMVZE', nif: 'B12345674', ts: '2026-11-16T10:31:02+01:00', t: 60, estado: 'Correcto', n: 2 }
    );
    assert.deepEqual(r.lineas[0], {
      idEmisorFactura: '89890001K', numSerieFactura: 'F26-000012', fechaExpedicion: '16-11-2026', tipoOperacion: 'Alta',
      subsanacion: false, refExterna: 'id-1', estadoRegistro: 'Correcto', codigoError: null, descripcionError: null, duplicado: null,
    });
    assert.equal(r.lineas[1].tipoOperacion, 'Anulacion');
  });

  it('envío parcialmente correcto: errores por registro y bloque de duplicado', () => {
    const r = interpretarRespuesta(
      sobreRespuesta(
        '<tikR:CSV>A-1</tikR:CSV>' + cabeceraRespuesta +
          '<tikR:TiempoEsperaEnvio>120</tikR:TiempoEsperaEnvio><tikR:EstadoEnvio>ParcialmenteCorrecto</tikR:EstadoEnvio>' +
          lineaXml('A1', 'AceptadoConErrores', '<tikR:CodigoErrorRegistro>2000</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>El cálculo de la huella suministrada es incorrecta.</tikR:DescripcionErrorRegistro>') +
          lineaXml('A2', 'Incorrecto', '<tikR:CodigoErrorRegistro>1100</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Valor o tipo incorrecto del campo: &lt;TipoFactura&gt;</tikR:DescripcionErrorRegistro>') +
          lineaXml('A3', 'Incorrecto',
            '<tikR:CodigoErrorRegistro>3000</tikR:CodigoErrorRegistro><tikR:DescripcionErrorRegistro>Registro de facturación duplicado.</tikR:DescripcionErrorRegistro>' +
            '<tikR:RegistroDuplicado><tik:IdPeticionRegistroDuplicado>20261116103101</tik:IdPeticionRegistroDuplicado><tik:EstadoRegistroDuplicado>Correcta</tik:EstadoRegistroDuplicado></tikR:RegistroDuplicado>')
      )
    );
    assert.ok(r?.tipo === 'RESPUESTA');
    assert.equal(r.tiempoEsperaSeg, 120);
    assert.deepEqual(r.lineas.map((l) => [l.estadoRegistro, l.codigoError]), [['AceptadoConErrores', '2000'], ['Incorrecto', '1100'], ['Incorrecto', '3000']]);
    assert.equal(r.lineas[1].descripcionError, 'Valor o tipo incorrecto del campo: <TipoFactura>');
    assert.deepEqual(r.lineas[2].duplicado, { idPeticion: '20261116103101', estado: 'Correcta', codigoError: null, descripcionError: null });
  });

  it('SOAP Fault: distingue el rechazo del mensaje (Client) del fallo de la AEAT (Server)', () => {
    const fault = (codigo: string, cadena: string) =>
      `<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="${NS.soapenv}"><env:Body><env:Fault><faultcode>${codigo}</faultcode><faultstring>${cadena}</faultstring></env:Fault></env:Body></env:Envelope>`;

    assert.deepEqual(
      interpretarRespuesta(fault('env:Client', 'Codigo[4104].Error en la cabecera: el valor del campo NIF del bloque ObligadoEmision no est&#225; identificado.\n NIF:89890001K')),
      { tipo: 'FAULT', delServidor: false, codigo: '4104', mensaje: 'Error en la cabecera: el valor del campo NIF del bloque ObligadoEmision no está identificado. NIF:89890001K' }
    );
    assert.deepEqual(interpretarRespuesta(fault('env:Server', 'Codigo[401].No hay conexion a @firma')), {
      tipo: 'FAULT', delServidor: true, codigo: '401', mensaje: 'No hay conexion a @firma',
    });
    assert.deepEqual(interpretarRespuesta(fault('soapenv:Server', 'Internal error')), {
      tipo: 'FAULT', delServidor: true, codigo: null, mensaje: 'Internal error',
    });
  });

  it('lo que no es una respuesta reconocible no se interpreta (ni aceptado ni rechazado)', () => {
    assert.equal(interpretarRespuesta(''), null);
    assert.equal(interpretarRespuesta('<html><body>502 Bad Gateway</body></html>'), null);
    assert.equal(interpretarRespuesta('esto no es XML <<<'), null);
    // Estado de envío desconocido, o una línea sin estado: tampoco se adivina.
    assert.equal(interpretarRespuesta(sobreRespuesta(cabeceraRespuesta + '<tikR:EstadoEnvio>Quizas</tikR:EstadoEnvio>')), null);
    assert.equal(
      interpretarRespuesta(sobreRespuesta(cabeceraRespuesta + '<tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>' + lineaXml('A1', 'Regular'))),
      null
    );
  });
});

/* ------------------------------ clasificación ------------------------------- */

const linea = (cambios: Partial<LineaRespuesta> = {}): LineaRespuesta => ({
  idEmisorFactura: '89890001K', numSerieFactura: 'A1', fechaExpedicion: '16-11-2026', tipoOperacion: 'Alta', subsanacion: false,
  refExterna: null, estadoRegistro: 'Correcto', codigoError: null, descripcionError: null, duplicado: null, ...cambios,
});

describe('Del resultado de la AEAT al estado del envío', () => {
  it('Correcto → ACEPTADO con CSV; AceptadoConErrores conserva el error; Incorrecto → RECHAZADO sin CSV', () => {
    const ctx = { csv: 'A-1', entregaIncierta: false };
    assert.deepEqual(desenlaceDeLinea(linea(), ctx), { estado: 'ACEPTADO', csv: 'A-1', codigoError: null, descripcionError: null, conciliado: false });
    assert.deepEqual(
      desenlaceDeLinea(linea({ estadoRegistro: 'AceptadoConErrores', codigoError: '2000', descripcionError: 'Huella incorrecta' }), ctx),
      { estado: 'ACEPTADO_CON_ERRORES', csv: 'A-1', codigoError: '2000', descripcionError: 'Huella incorrecta', conciliado: false }
    );
    assert.deepEqual(
      desenlaceDeLinea(linea({ estadoRegistro: 'Incorrecto', codigoError: '1100', descripcionError: 'Campo incorrecto' }), ctx),
      { estado: 'RECHAZADO', csv: null, codigoError: '1100', descripcionError: 'Campo incorrecto', conciliado: false }
    );
  });

  it('un duplicado tras un intento sin respuesta es una CONFIRMACIÓN; sin ese intento, un rechazo', () => {
    const dup = (estado: 'Correcta' | 'AceptadaConErrores' | 'Anulada') =>
      linea({
        estadoRegistro: 'Incorrecto', codigoError: '3000', descripcionError: 'Registro de facturación duplicado.',
        duplicado: { idPeticion: '77', estado, codigoError: estado === 'AceptadaConErrores' ? '2000' : null, descripcionError: estado === 'AceptadaConErrores' ? 'Huella incorrecta' : null },
      });

    const incierto = { csv: null, entregaIncierta: true };
    assert.deepEqual(desenlaceDeLinea(dup('Correcta'), incierto), { estado: 'ACEPTADO', csv: null, codigoError: null, descripcionError: null, conciliado: true });
    assert.deepEqual(desenlaceDeLinea(dup('AceptadaConErrores'), incierto), {
      estado: 'ACEPTADO_CON_ERRORES', csv: null, codigoError: '2000', descripcionError: 'Huella incorrecta', conciliado: true,
    });
    assert.equal(desenlaceDeLinea(dup('Anulada'), incierto).estado, 'ACEPTADO');

    // Primer intento y ya consta en la AEAT: lo registró otro; es un rechazo real.
    assert.deepEqual(desenlaceDeLinea(dup('Correcta'), { csv: null, entregaIncierta: false }), {
      estado: 'RECHAZADO', csv: null, codigoError: '3000', descripcionError: 'Registro de facturación duplicado.', conciliado: false,
    });
  });

  it('casa cada línea con su registro: por RefExterna y, si falta, por factura y operación', () => {
    const enviados = [
      { registroId: 'r1', numSerieFactura: 'A1', tipoRegistro: 'ALTA' as const, esSubsanacion: false },
      { registroId: 'r2', numSerieFactura: 'A1', tipoRegistro: 'ANULACION' as const, esSubsanacion: false },
      { registroId: 'r3', numSerieFactura: 'A2', tipoRegistro: 'ALTA' as const, esSubsanacion: true },
      { registroId: 'r4', numSerieFactura: 'A9', tipoRegistro: 'ALTA' as const, esSubsanacion: false },
    ];
    // Las líneas llegan DESORDENADAS y solo una trae RefExterna.
    const lineas = [
      linea({ numSerieFactura: 'A2', subsanacion: true, codigoError: 'L3' }),
      linea({ numSerieFactura: 'A1', tipoOperacion: 'Anulacion', codigoError: 'L2' }),
      linea({ numSerieFactura: 'OTRA', refExterna: 'r1', codigoError: 'L1' }),
    ];
    const mapa = emparejarLineas(enviados, lineas);
    assert.deepEqual([...mapa].map(([id, l]) => [id, l.codigoError]).sort(), [['r1', 'L1'], ['r2', 'L2'], ['r3', 'L3']]);
    assert.equal(mapa.has('r4'), false, 'un registro sin línea no se da por respondido');
  });

  it('clasifica el desenlace del mensaje: respuesta, fallo transitorio o rechazo del envío', () => {
    const ok = interpretarRespuesta(sobreRespuesta(cabeceraRespuesta + '<tikR:EstadoEnvio>Correcto</tikR:EstadoEnvio>'))!;
    assert.equal(clasificarRespuestaHttp({ estado: 200, cuerpo: 'x' }, ok).tipo, 'RESPUESTA');

    const tipo = (estado: number, respuesta: Parameters<typeof clasificarRespuestaHttp>[1] = null) => {
      const d = clasificarRespuestaHttp({ estado, cuerpo: '' }, respuesta);
      return d.tipo === 'RESPUESTA' ? ['RESPUESTA'] : [d.tipo, d.codigo, d.entregaIncierta];
    };
    // Sin cuerpo SOAP manda el código HTTP.
    assert.deepEqual(tipo(503), ['TRANSITORIO', 'HTTP_503', true]);
    assert.deepEqual(tipo(502), ['TRANSITORIO', 'HTTP_502', true]);
    assert.deepEqual(tipo(429), ['TRANSITORIO', 'HTTP_429', false]);
    assert.deepEqual(tipo(403), ['RECHAZO_ENVIO', 'HTTP_403', false]);
    assert.deepEqual(tipo(404), ['RECHAZO_ENVIO', 'HTTP_404', false]);
    assert.deepEqual(tipo(200), ['TRANSITORIO', 'RESPUESTA_ILEGIBLE', true]);
    // Con SOAP Fault manda el Fault, venga con el HTTP que venga.
    assert.deepEqual(tipo(500, { tipo: 'FAULT', delServidor: false, codigo: '4102', mensaje: 'El XML no cumple el esquema' }), ['RECHAZO_ENVIO', '4102', false]);
    assert.deepEqual(tipo(500, { tipo: 'FAULT', delServidor: true, codigo: null, mensaje: 'Internal error' }), ['TRANSITORIO', 'FAULT_SERVER', true]);

    // Fallos de red: lo que importa es si el mensaje pudo llegar.
    const red = clasificarErrorDeEnvio(new ErrorTransporte('ECONNREFUSED', 'sin conexión', false));
    assert.ok(red.tipo === 'TRANSITORIO' && red.codigo === 'ECONNREFUSED' && red.entregaIncierta === false);
    const timeout = clasificarErrorDeEnvio(new ErrorTransporte('TIMEOUT', 'sin respuesta', true));
    assert.ok(timeout.tipo === 'TRANSITORIO' && timeout.entregaIncierta === true);
    const raro = clasificarErrorDeEnvio(new TypeError('algo inesperado'));
    assert.ok(raro.tipo === 'TRANSITORIO' && raro.entregaIncierta === true, 'ante la duda, incierto');
  });
});
