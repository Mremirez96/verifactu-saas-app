/**
 * Tests unitarios de la huella.  →  pnpm test
 * No necesitan base de datos.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ErrorDominio } from '../../errores';
import { fechaEnHuso, fechaHoraHuso, formatearFecha, formatearImporte } from '../formato';
import {
  cadenaRegistroAlta,
  cadenaRegistroAnulacion,
  huellaRegistroAlta,
  huellaRegistroAnulacion,
  sha256Hex,
  type DatosHuellaAlta,
} from '../huella';

/**
 * Ejemplos OFICIALES del documento de la AEAT «Detalle de las especificaciones
 * técnicas para generación de la huella o hash de los registros de
 * facturación» (v0.1.2). Si estos tres tests pasan, la cadena de texto y el
 * algoritmo son, byte a byte, los que espera la AEAT.
 */
const AEAT = {
  primerAlta: {
    datos: {
      idEmisorFactura: '89890001K',
      numSerieFactura: '12345678/G33',
      fechaExpedicion: '2024-01-01',
      tipoFactura: 'F1',
      cuotaTotal: '12.35',
      importeTotal: '123.45',
      huellaAnterior: null,
      fechaHoraHusoGen: '2024-01-01T19:20:30+01:00',
    } satisfies DatosHuellaAlta,
    cadena:
      'IDEmisorFactura=89890001K&NumSerieFactura=12345678/G33&FechaExpedicionFactura=01-01-2024&TipoFactura=F1&CuotaTotal=12.35&ImporteTotal=123.45&Huella=&FechaHoraHusoGenRegistro=2024-01-01T19:20:30+01:00',
    huella: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
  },
  segundaAlta: {
    datos: {
      idEmisorFactura: '89890001K',
      numSerieFactura: '12345679/G34',
      fechaExpedicion: '2024-01-01',
      tipoFactura: 'F1',
      cuotaTotal: '12.35',
      importeTotal: '123.45',
      huellaAnterior: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
      fechaHoraHusoGen: '2024-01-01T19:20:35+01:00',
    } satisfies DatosHuellaAlta,
    huella: 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97',
  },
  anulacion: {
    datos: {
      idEmisorFactura: '89890001K',
      numSerieFactura: '12345679/G34',
      fechaExpedicion: '2024-01-01',
      huellaAnterior: 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97',
      fechaHoraHusoGen: '2024-01-01T19:20:40+01:00',
    },
    cadena:
      'IDEmisorFacturaAnulada=89890001K&NumSerieFacturaAnulada=12345679/G34&FechaExpedicionFacturaAnulada=01-01-2024&Huella=F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97&FechaHoraHusoGenRegistro=2024-01-01T19:20:40+01:00',
    huella: '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68',
  },
};

describe('Huella: ejemplos oficiales de la AEAT', () => {
  it('primer registro de alta (sin huella anterior)', () => {
    assert.equal(cadenaRegistroAlta(AEAT.primerAlta.datos), AEAT.primerAlta.cadena);
    assert.equal(huellaRegistroAlta(AEAT.primerAlta.datos), AEAT.primerAlta.huella);
  });

  it('segundo registro de alta, encadenado al primero', () => {
    assert.equal(huellaRegistroAlta(AEAT.segundaAlta.datos), AEAT.segundaAlta.huella);
  });

  it('registro de anulación, encadenado al segundo', () => {
    assert.equal(cadenaRegistroAnulacion(AEAT.anulacion.datos), AEAT.anulacion.cadena);
    assert.equal(huellaRegistroAnulacion(AEAT.anulacion.datos), AEAT.anulacion.huella);
  });

  it('la cadena de los tres ejemplos se reconstruye sola, eslabón a eslabón', () => {
    const h1 = huellaRegistroAlta(AEAT.primerAlta.datos);
    const h2 = huellaRegistroAlta({ ...AEAT.segundaAlta.datos, huellaAnterior: h1 });
    const h3 = huellaRegistroAnulacion({ ...AEAT.anulacion.datos, huellaAnterior: h2 });
    assert.deepEqual([h1, h2, h3], [AEAT.primerAlta.huella, AEAT.segundaAlta.huella, AEAT.anulacion.huella]);
  });
});

describe('Huella: normalización', () => {
  const base = AEAT.primerAlta.datos;

  it('64 caracteres hexadecimales en mayúsculas', () => {
    assert.match(huellaRegistroAlta(base), /^[0-9A-F]{64}$/);
  });

  it('ignora los espacios alrededor de los valores', () => {
    const conEspacios = { ...base, idEmisorFactura: ' 89890001K ', numSerieFactura: '  12345678/G33 ' };
    assert.equal(huellaRegistroAlta(conEspacios), AEAT.primerAlta.huella);
  });

  it('el importe se escribe siempre con dos decimales, venga como venga', () => {
    assert.equal(formatearImporte('123.1'), '123.10');
    assert.equal(formatearImporte('123'), '123.00');
    assert.equal(formatearImporte(12.35), '12.35');
    assert.equal(formatearImporte('007.50'), '7.50');
    assert.equal(formatearImporte('-12.1'), '-12.10'); // rectificativas
    assert.equal(formatearImporte('-0.00'), '0.00');
    // Misma factura expresada de tres formas → misma cadena → misma huella.
    const h = (cuotaTotal: string | number) => huellaRegistroAlta({ ...base, cuotaTotal });
    assert.equal(h('12.3'), h('12.30'));
    assert.equal(h(12.3), h('12.30'));
  });

  it('no redondea ni acepta importes mal formados', () => {
    for (const malo of ['12.345', '12,35', '1e3', '', 'abc', '12.']) {
      assert.throws(() => formatearImporte(malo), ErrorDominio, `debería rechazar "${malo}"`);
    }
    assert.throws(() => formatearImporte(12.345), ErrorDominio);
    assert.throws(() => formatearImporte(Number.NaN), ErrorDominio);
  });

  it('la fecha de expedición pasa de YYYY-MM-DD a DD-MM-YYYY', () => {
    assert.equal(formatearFecha('2026-11-16'), '16-11-2026');
    assert.throws(() => formatearFecha('16-11-2026'), ErrorDominio);
    assert.throws(() => formatearFecha('2026-13-01'), ErrorDominio);
  });

  it('los valores no se codifican como URL y se hashean en UTF-8', () => {
    const cadena = cadenaRegistroAlta({ ...base, numSerieFactura: 'AÑO 26/001' });
    assert.ok(cadena.includes('NumSerieFactura=AÑO 26/001&'));
    // 'Ñ' son dos bytes en UTF-8 (C3 91) y uno en Latin-1 (D1): la huella sale de los de UTF-8.
    const deBytes = (bytes: number[]) =>
      createHash('sha256').update(Buffer.from(bytes)).digest('hex').toUpperCase();
    assert.equal(sha256Hex('Ñ'), deBytes([0xc3, 0x91]));
    assert.notEqual(sha256Hex('Ñ'), deBytes([0xd1]));
  });

  it('rechaza datos que producirían una huella sin valor', () => {
    assert.throws(() => huellaRegistroAlta({ ...base, idEmisorFactura: '123' }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, numSerieFactura: '   ' }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, tipoFactura: 'F9' as never }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, fechaHoraHusoGen: '2024-01-01 19:20:30' }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, fechaHoraHusoGen: '2024-01-01T19:20:30Z' }), ErrorDominio);
    // '' no es "primer registro": tiene que ser null, a propósito.
    assert.throws(() => huellaRegistroAlta({ ...base, huellaAnterior: '' }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, huellaAnterior: 'abc' }), ErrorDominio);
    assert.throws(() => huellaRegistroAlta({ ...base, huellaAnterior: AEAT.primerAlta.huella.toLowerCase() }), ErrorDominio);
  });
});

describe('Huella: sensibilidad (cualquier cambio en un dato cambia la huella)', () => {
  const base = AEAT.segundaAlta.datos;
  const original = huellaRegistroAlta(base);

  const cambios: Record<keyof DatosHuellaAlta, DatosHuellaAlta[keyof DatosHuellaAlta]> = {
    idEmisorFactura: '89890001L',
    numSerieFactura: '12345679/G35',
    fechaExpedicion: '2024-01-02',
    tipoFactura: 'F2',
    cuotaTotal: '12.36', // un céntimo
    importeTotal: '123.46', // un céntimo
    huellaAnterior: AEAT.anulacion.huella,
    fechaHoraHusoGen: '2024-01-01T19:20:36+01:00', // un segundo
  };

  for (const [campo, valor] of Object.entries(cambios)) {
    it(`cambia al modificar ${campo}`, () => {
      const alterada = huellaRegistroAlta({ ...base, [campo]: valor } as DatosHuellaAlta);
      assert.notEqual(alterada, original);
      // Efecto avalancha: no cambia "un poco", cambia casi todo.
      const iguales = [...alterada].filter((c, i) => c === original[i]).length;
      assert.ok(iguales < 20, `solo deberían coincidir por azar unos 4 de 64 caracteres; coinciden ${iguales}`);
    });
  }

  it('la misma hora en otro huso es OTRA huella (el texto forma parte del registro)', () => {
    const enUtc = { ...base, fechaHoraHusoGen: '2024-01-01T18:20:35+00:00' };
    assert.equal(Date.parse(enUtc.fechaHoraHusoGen), Date.parse(base.fechaHoraHusoGen));
    assert.notEqual(huellaRegistroAlta(enUtc), original);
  });
});

describe('Fecha-hora de generación con huso', () => {
  it('aplica el huso de la empresa y el horario de verano', () => {
    const invierno = new Date('2026-01-15T12:00:00Z');
    const verano = new Date('2026-07-15T12:00:00Z');
    assert.equal(fechaHoraHuso(invierno, 'Europe/Madrid'), '2026-01-15T13:00:00+01:00');
    assert.equal(fechaHoraHuso(verano, 'Europe/Madrid'), '2026-07-15T14:00:00+02:00');
    assert.equal(fechaHoraHuso(invierno, 'Atlantic/Canary'), '2026-01-15T12:00:00+00:00');
    assert.equal(fechaHoraHuso(verano, 'Atlantic/Canary'), '2026-07-15T13:00:00+01:00');
  });

  it('representa el mismo instante que recibió y descarta los milisegundos', () => {
    const instante = new Date('2026-11-16T00:19:07.999Z');
    const texto = fechaHoraHuso(instante, 'Europe/Madrid');
    assert.equal(texto, '2026-11-16T01:19:07+01:00');
    assert.equal(Date.parse(texto), Math.floor(instante.getTime() / 1000) * 1000);
  });

  it('la fecha de expedición es la del calendario local, no la de UTC', () => {
    const casiMedianoche = new Date('2026-12-31T23:30:00Z'); // ya es 1 de enero en la Península
    assert.equal(fechaEnHuso(casiMedianoche, 'Europe/Madrid'), '2027-01-01');
    assert.equal(fechaEnHuso(casiMedianoche, 'Atlantic/Canary'), '2026-12-31');
  });
});
