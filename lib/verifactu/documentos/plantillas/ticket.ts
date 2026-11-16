import type { ModeloDocumento } from '../modelo';
import { avisoEstado, bloqueQr, documento, html, pie } from './base';

/**
 * Ticket / factura simplificada para impresora térmica (papel de 80 o 58 mm)
 * y para enseñar o enviar desde el móvil.
 *
 * Posición del QR: al PRINCIPIO del ticket, centrado, antes del contenido.
 * Una sola columna y precios con impuestos incluidos, que es lo que el
 * cliente espera leer; el desglose por tipo va al final.
 */
export function plantillaTicket(modelo: ModeloDocumento): string {
  const estrecho = modelo.formato === 'TICKET_58';

  const cuerpo = html`
<main class="hoja">
  ${avisoEstado(modelo)}
  ${bloqueQr(modelo)}

  <header class="emisor">
    <p class="nombre">${modelo.emisor.nombre}</p>
    <p>NIF: ${modelo.emisor.nif}</p>
    ${modelo.emisor.domicilio && html`<p>${modelo.emisor.domicilio}</p>`}
  </header>

  <section class="identificacion">
    <p class="titulo">${modelo.titulo}</p>
    <p>N.º ${modelo.numSerieFactura ?? '—'}</p>
    <p>Fecha: ${modelo.fechaExpedicion ?? '—'}</p>
    ${modelo.fechaOperacion && html`<p>Fecha de operación: ${modelo.fechaOperacion}</p>`}
  </section>

  ${modelo.destinatario &&
  html`<section class="destinatario">
    <p>Cliente: ${modelo.destinatario.nombre}</p>
    ${modelo.destinatario.identificacion && html`<p>NIF: ${modelo.destinatario.identificacion}</p>`}
    ${modelo.destinatario.domicilio && html`<p>${modelo.destinatario.domicilio}</p>`}
  </section>`}

  <table class="lineas">
    <tbody>
      ${modelo.lineas.map(
        (l) => html`<tr>
        <td>${l.descripcion}<span class="detalle">${l.cantidad} × ${l.precioUnitario}${l.descuento && html` · dto. ${l.descuento}`} · ${l.tipo}</span></td>
        <td class="num">${l.importeConImpuestos}</td>
      </tr>`
      )}
    </tbody>
  </table>

  <table class="totales">
    <tbody>
      <tr class="total"><th>TOTAL</th><td class="num">${modelo.totales.importeTotal}</td></tr>
      ${modelo.totales.retencion &&
      html`<tr><th>Retención IRPF ${modelo.totales.retencion.porcentaje}</th><td class="num">−${modelo.totales.retencion.importe}</td></tr>
      <tr class="total"><th>A PAGAR</th><td class="num">${modelo.totales.totalAPagar}</td></tr>`}
    </tbody>
  </table>
  <p class="incluido">Impuestos incluidos</p>

  <table class="desglose">
    <thead><tr><th>Impuesto</th><th class="num">Base</th><th class="num">Cuota</th></tr></thead>
    <tbody>
      ${modelo.desglose.map(
        (d) => html`<tr><td>${d.concepto}</td><td class="num">${d.base}</td><td class="num">${d.cuota ?? '—'}</td></tr>
        ${d.recargo && html`<tr><td>Rec. equiv. ${d.recargo.tipo}</td><td></td><td class="num">${d.recargo.cuota}</td></tr>`}`
      )}
    </tbody>
  </table>

  ${modelo.menciones.length > 0 && html`<section class="menciones">${modelo.menciones.map((m) => html`<p>${m}</p>`)}</section>`}
  ${modelo.observaciones && html`<section class="observaciones"><p>${modelo.observaciones}</p></section>`}
  ${pie(modelo)}
</main>`;

  return documento({
    titulo: `${modelo.titulo} ${modelo.numSerieFactura ?? '(borrador)'}`,
    clase: estrecho ? 'doc-ticket doc-ticket-58' : 'doc-ticket doc-ticket-80',
    estilos: estilosTicket(estrecho, altoEstimadoMm(modelo)),
    cuerpo,
  });
}

/**
 * Alto aproximado del ticket impreso, en milímetros.
 *
 * Un ticket no tiene alto fijo y CSS no sabe decir «80 mm de ancho y lo que
 * haga falta de alto» (`@page{size:80mm auto}` no es válido y el navegador
 * volvería a A4/carta). Se declara entonces un alto calculado por lo alto a
 * partir del contenido: al «guardar como PDF» sale una sola página con forma
 * de ticket. En una impresora térmica manda el tamaño de papel del
 * controlador, no este valor.
 */
function altoEstimadoMm(modelo: ModeloDocumento): number {
  const estrecho = modelo.formato === 'TICKET_58';
  const linea = estrecho ? 3.7 : 4.2; // alto de un renglón de texto
  const ancho = estrecho ? 34 : 44; // caracteres que caben en un renglón
  const renglones = (texto: string | null | undefined, caben = ancho) =>
    texto ? Math.max(1, Math.ceil(texto.length / caben)) : 0;

  let alto = estrecho ? 6 : 10; // márgenes de página
  alto += modelo.estado === 'EMITIDA' ? 0 : 12; // aviso de borrador / anulada
  alto += modelo.qr ? modelo.qr.imagen.ladoTotalMm + 3 * linea + 4 : 0; // texto + QR + leyenda
  alto += (2.3 + renglones(modelo.emisor.nombre, ancho * 0.8) * 1.25 + renglones(modelo.emisor.domicilio)) * linea;
  alto += (3 + (modelo.fechaOperacion ? 1 : 0)) * linea + 6;
  if (modelo.destinatario) {
    alto += (2 + renglones(modelo.destinatario.nombre) + renglones(modelo.destinatario.domicilio)) * linea + 6;
  }
  for (const l of modelo.lineas) {
    alto += (renglones(l.descripcion, ancho * 0.72) + 1.2) * linea + 2.6;
  }
  alto += (modelo.totales.retencion ? 5.5 : 2.6) * linea + 12; // totales + «impuestos incluidos»
  alto += (1.3 + modelo.desglose.length + modelo.desglose.filter((d) => d.recargo).length) * linea + 5;
  alto += modelo.menciones.reduce((suma, m) => suma + renglones(m), 0) * linea + (modelo.menciones.length ? 4 : 0);
  alto += renglones(modelo.observaciones) * linea + (modelo.observaciones ? 4 : 0);
  alto += modelo.pie.reduce((suma, p) => suma + renglones(p, ancho * 1.2), 0) * linea * 0.85 + 8;

  return Math.ceil(alto * 1.08); // holgura: mejor un poco de papel en blanco que una segunda página
}

/**
 * 80 mm de papel → 72 mm útiles; 58 mm → 54 mm útiles. En ambos cabe el QR
 * completo (30-32 mm de símbolo más su margen blanco, menos de 40 mm en total).
 */
function estilosTicket(estrecho: boolean, altoMm: number): string {
  const papel = estrecho ? 58 : 80;
  const margen = estrecho ? 2 : 4;
  return `
@page{size:${papel}mm ${altoMm}mm;margin:${margen}mm}
.doc-ticket{font-size:${estrecho ? 8 : 9}pt;line-height:1.3}
.hoja{background:#fff;width:${papel}mm;max-width:100%;margin:0 auto 24px;padding:${margen}mm;box-shadow:0 1px 6px rgba(0,0,0,.18)}
.hoja>*+*{margin-top:3mm}
.emisor,.identificacion{text-align:center}
.nombre{font-weight:700;font-size:1.25em}
.titulo{font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.identificacion,.destinatario{border-top:.2mm dashed #111;padding-top:2mm}
.lineas{border-top:.2mm dashed #111}
.lineas td{padding:1.2mm 0;vertical-align:top}
.detalle{display:block;color:#444;font-size:.9em}
.totales{border-top:.2mm dashed #111}
.totales th{text-align:left;font-weight:400;padding:.8mm 0}
.totales .total th,.totales .total td{font-weight:700;font-size:1.35em;padding-top:1.5mm}
.incluido{text-align:right;font-size:.9em;margin-top:0!important}
.desglose th{font-weight:600;text-align:left;border-bottom:.2mm solid #111;font-size:.9em}
.desglose th.num{text-align:right}
.desglose td{font-size:.9em;padding:.6mm 0}
.pie{border-top:.2mm dashed #111;padding-top:2mm;font-size:.78em;text-align:center}
@media print{.hoja{width:auto;margin:0;padding:0;box-shadow:none}}
`;
}
