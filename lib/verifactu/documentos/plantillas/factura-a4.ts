import type { ModeloDocumento } from '../modelo';
import { avisoEstado, bloqueQr, documento, html, pie } from './base';

/**
 * Factura en A4 vertical.
 *
 * Posición del QR: es lo PRIMERO del documento, arriba y junto al margen
 * izquierdo, antes de cualquier otro contenido, que es donde la AEAT pide
 * que esté en los formatos verticales.
 */
export function plantillaFacturaA4(modelo: ModeloDocumento): string {
  const hayDescuentos = modelo.lineas.some((l) => l.descuento);

  const cuerpo = html`
<main class="hoja">
  ${avisoEstado(modelo)}
  <header class="cabecera">
    ${bloqueQr(modelo)}
    <div class="identificacion">
      <h1>${modelo.titulo}</h1>
      <dl>
        <div><dt>Número</dt><dd>${modelo.numSerieFactura ?? '—'}</dd></div>
        <div><dt>Fecha de expedición</dt><dd>${modelo.fechaExpedicion ?? '—'}</dd></div>
        ${modelo.fechaOperacion && html`<div><dt>Fecha de operación</dt><dd>${modelo.fechaOperacion}</dd></div>`}
      </dl>
    </div>
  </header>

  <section class="partes">
    <div class="parte">
      <h2>Emisor</h2>
      <p class="nombre">${modelo.emisor.nombre}</p>
      <p>NIF: ${modelo.emisor.nif}</p>
      ${modelo.emisor.domicilio && html`<p>${modelo.emisor.domicilio}</p>`}
    </div>
    ${modelo.destinatario &&
    html`<div class="parte">
      <h2>Destinatario</h2>
      <p class="nombre">${modelo.destinatario.nombre}</p>
      ${modelo.destinatario.identificacion && html`<p>NIF: ${modelo.destinatario.identificacion}</p>`}
      ${modelo.destinatario.domicilio && html`<p>${modelo.destinatario.domicilio}</p>`}
    </div>`}
  </section>

  <table class="lineas">
    <thead>
      <tr>
        <th>Descripción</th><th class="num">Cantidad</th><th class="num">Precio</th>
        ${hayDescuentos && html`<th class="num">Dto.</th>`}
        <th class="num">Impuesto</th><th class="num">Base</th>
      </tr>
    </thead>
    <tbody>
      ${modelo.lineas.map(
        (l) => html`<tr>
        <td>${l.descripcion}</td><td class="num">${l.cantidad}</td><td class="num">${l.precioUnitario}</td>
        ${hayDescuentos && html`<td class="num">${l.descuento ?? ''}</td>`}
        <td class="num">${l.tipo}</td><td class="num">${l.base}</td>
      </tr>`
      )}
    </tbody>
  </table>

  <section class="resumen">
    <table class="desglose">
      <thead><tr><th>Impuesto</th><th class="num">Base imponible</th><th class="num">Cuota</th></tr></thead>
      <tbody>
        ${modelo.desglose.map(
          (d) => html`<tr><td>${d.concepto}</td><td class="num">${d.base}</td><td class="num">${d.cuota ?? '—'}</td></tr>
          ${d.recargo && html`<tr><td>Recargo de equivalencia ${d.recargo.tipo}</td><td></td><td class="num">${d.recargo.cuota}</td></tr>`}`
        )}
      </tbody>
    </table>
    <table class="totales">
      <tbody>
        <tr><th>Base imponible</th><td class="num">${modelo.totales.baseImponible}</td></tr>
        <tr><th>Cuota</th><td class="num">${modelo.totales.cuotaTotal}</td></tr>
        <tr class="total"><th>Total factura</th><td class="num">${modelo.totales.importeTotal}</td></tr>
        ${modelo.totales.retencion &&
        html`<tr><th>Retención IRPF ${modelo.totales.retencion.porcentaje}</th><td class="num">−${modelo.totales.retencion.importe}</td></tr>
        <tr class="total"><th>Total a pagar</th><td class="num">${modelo.totales.totalAPagar}</td></tr>`}
      </tbody>
    </table>
  </section>

  ${modelo.menciones.length > 0 && html`<section class="menciones">${modelo.menciones.map((m) => html`<p>${m}</p>`)}</section>`}
  ${modelo.observaciones && html`<section class="observaciones"><h2>Observaciones</h2><p>${modelo.observaciones}</p></section>`}
  ${pie(modelo)}
</main>`;

  return documento({
    titulo: `${modelo.titulo} ${modelo.numSerieFactura ?? '(borrador)'}`,
    clase: 'doc-a4',
    estilos: ESTILOS_A4,
    cuerpo,
  });
}

const ESTILOS_A4 = `
@page{size:A4 portrait;margin:14mm}
.doc-a4{font-size:10pt;line-height:1.35}
.hoja{background:#fff;width:210mm;max-width:100%;min-height:297mm;margin:0 auto 24px;padding:14mm;box-shadow:0 1px 6px rgba(0,0,0,.18)}
.cabecera{display:flex;align-items:flex-start;justify-content:space-between;gap:8mm;margin-bottom:8mm}
.cabecera .qr{flex:none}
.identificacion{text-align:right;flex:1}
h1{font-size:18pt;margin-bottom:3mm}
h2{font-size:8.5pt;text-transform:uppercase;letter-spacing:.05em;color:#555;margin-bottom:1.5mm}
dl div{display:flex;justify-content:flex-end;gap:3mm}
dt{color:#555}
dd{font-weight:600;min-width:28mm}
.partes{display:flex;gap:10mm;margin-bottom:8mm}
.parte{flex:1}
.nombre{font-weight:700;font-size:11pt}
.lineas th,.desglose th{font-size:8.5pt;text-transform:uppercase;letter-spacing:.04em;color:#555;text-align:left;border-bottom:.3mm solid #111;padding:1.5mm 1mm}
.lineas th.num,.desglose th.num{text-align:right}
.lineas td,.desglose td{padding:1.8mm 1mm;border-bottom:.15mm solid #ccc;vertical-align:top}
.lineas tr{break-inside:avoid}
.resumen{display:flex;justify-content:space-between;align-items:flex-start;gap:10mm;margin-top:6mm;break-inside:avoid}
.desglose{width:55%}
.totales{width:38%}
.totales th{text-align:left;font-weight:400;padding:1.2mm 1mm}
.totales td{padding:1.2mm 1mm}
.totales .total th,.totales .total td{font-weight:700;font-size:12pt;border-top:.3mm solid #111}
.menciones,.observaciones{margin-top:6mm}
.pie{margin-top:10mm;border-top:.15mm solid #ccc;padding-top:2mm;font-size:7.5pt}
@media print{.hoja{width:auto;min-height:0;margin:0;padding:0;box-shadow:none}}
@media screen and (max-width:640px){
  .hoja{padding:5mm;min-height:0}
  .cabecera,.partes,.resumen{flex-direction:column}
  .identificacion{text-align:left}
  dl div{justify-content:flex-start}
  .desglose,.totales{width:100%}
}
`;
