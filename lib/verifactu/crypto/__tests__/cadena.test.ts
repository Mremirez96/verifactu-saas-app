/**
 * Tests unitarios del encadenamiento.  →  pnpm test
 *
 * Demuestran, sin base de datos, la propiedad en la que descansa todo el
 * sistema: NO se puede alterar un registro pasado sin que la cadena lo delate.
 * Cada test hace de "defraudador" con un nivel de sofisticación mayor.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { recalcularHuella, verificarCadena, type RegistroEncadenado } from '../cadena';

const AHORA = new Date('2026-11-16T12:00:00+01:00');

type Semilla = { tipo?: 'ALTA' | 'ANULACION'; numSerie: string; importe?: string; cuota?: string };

/** Construye una cadena legítima: cada registro lleva la huella del anterior. */
function construirCadena(semillas: Semilla[]): RegistroEncadenado[] {
  const cadena: RegistroEncadenado[] = [];
  semillas.forEach((semilla, i) => {
    const anterior = cadena.at(-1) ?? null;
    const alta = (semilla.tipo ?? 'ALTA') === 'ALTA';
    const registro: RegistroEncadenado = {
      numSecuencia: i + 1,
      tipoRegistro: alta ? 'ALTA' : 'ANULACION',
      idEmisorFactura: '89890001K',
      numSerieFactura: semilla.numSerie,
      fechaExpedicion: '2026-11-16',
      tipoFactura: alta ? 'F2' : null,
      cuotaTotal: alta ? (semilla.cuota ?? '21.00') : null,
      importeTotal: alta ? (semilla.importe ?? '121.00') : null,
      esPrimerRegistro: anterior === null,
      huellaAnterior: anterior?.huella ?? null,
      fechaHoraHusoGen: `2026-11-16T10:00:${String(i * 5).padStart(2, '0')}+01:00`,
      huella: '',
    };
    registro.huella = recalcularHuella(registro);
    cadena.push(registro);
  });
  return cadena;
}

const SEMILLAS: Semilla[] = [
  { numSerie: 'T26-000001' },
  { numSerie: 'T26-000002', importe: '48.40', cuota: '8.40' },
  { numSerie: 'T26-000003', importe: '1210.00', cuota: '210.00' },
  { numSerie: 'T26-000002', tipo: 'ANULACION' },
  { numSerie: 'T26-000004' },
  { numSerie: 'T26-000005', importe: '12.10', cuota: '2.10' },
];

/** Copia profunda, para manipular sin tocar la original. */
const clonar = (cadena: RegistroEncadenado[]) => cadena.map((r) => ({ ...r }));
const codigos = (cadena: RegistroEncadenado[], ancla?: string | null) =>
  verificarCadena(cadena, { ahora: AHORA, ultimaHuellaEsperada: ancla }).anomalias.map(
    (a) => `${a.codigo}@${a.numSecuencia}`
  );

describe('Cadena legítima', () => {
  const cadena = construirCadena(SEMILLAS);
  const ancla = cadena.at(-1)!.huella;

  it('se verifica sin anomalías, con altas y anulaciones mezcladas', () => {
    const resultado = verificarCadena(cadena, { ahora: AHORA, ultimaHuellaEsperada: ancla });
    assert.equal(resultado.integra, true);
    assert.equal(resultado.registrosVerificados, 6);
    assert.equal(resultado.ultimaHuella, ancla);
    assert.deepEqual(resultado.anomalias, []);
  });

  it('cada registro guarda exactamente la huella del anterior', () => {
    for (let i = 1; i < cadena.length; i++) {
      assert.equal(cadena[i].huellaAnterior, cadena[i - 1].huella);
    }
    assert.equal(cadena[0].huellaAnterior, null);
    assert.equal(new Set(cadena.map((r) => r.huella)).size, cadena.length);
  });

  it('el orden en que llegan los registros no importa: se ordenan por secuencia', () => {
    assert.equal(verificarCadena([...cadena].reverse(), { ahora: AHORA }).integra, true);
  });

  it('un tramo intermedio se puede verificar por separado (verificación parcial)', () => {
    const tramo = cadena.slice(2, 5);
    assert.equal(verificarCadena(tramo, { ahora: AHORA, tramoParcial: true }).integra, true);
    // Sin avisar de que es un tramo, el primero parece huérfano.
    assert.deepEqual(codigos(tramo), ['04@3']);
  });

  it('una cadena vacía es íntegra salvo que se esperase contenido', () => {
    assert.equal(verificarCadena([], { ahora: AHORA }).integra, true);
    assert.equal(verificarCadena([], { ahora: AHORA, ultimaHuellaEsperada: null }).integra, true);
    assert.equal(verificarCadena([], { ahora: AHORA, ultimaHuellaEsperada: ancla }).integra, false);
  });
});

describe('Ruptura de la cadena al alterar un registro previo', () => {
  const original = construirCadena(SEMILLAS);
  const ancla = original.at(-1)!.huella;

  it('NIVEL 1 · retocar un importe sin más → la huella de ESE registro deja de cuadrar', () => {
    const cadena = clonar(original);
    cadena[2].importeTotal = '121.00'; // la factura de 1.210 € "pasa a ser" de 121 €
    cadena[2].cuotaTotal = '21.00';

    assert.notEqual(recalcularHuella(cadena[2]), cadena[2].huella);
    assert.deepEqual(codigos(cadena, ancla), ['01@3']);
  });

  it('NIVEL 1 · basta un céntimo, un carácter o un segundo', () => {
    const variantes: Array<(r: RegistroEncadenado) => void> = [
      (r) => (r.importeTotal = '1210.01'),
      (r) => (r.cuotaTotal = '209.99'),
      (r) => (r.numSerieFactura = 'T26-000008'),
      (r) => (r.fechaExpedicion = '2026-11-15'),
      (r) => (r.idEmisorFactura = '89890001L'),
      (r) => (r.tipoFactura = 'F1'),
      (r) => (r.fechaHoraHusoGen = '2026-11-16T10:00:11+01:00'),
    ];
    for (const alterar of variantes) {
      const cadena = clonar(original);
      alterar(cadena[2]);
      assert.deepEqual(codigos(cadena, ancla), ['01@3']);
    }
  });

  it('NIVEL 2 · retocar el importe Y recalcular su huella → se rompe el enlace con el siguiente', () => {
    const cadena = clonar(original);
    cadena[2].importeTotal = '121.00';
    cadena[2].cuotaTotal = '21.00';
    cadena[2].huella = recalcularHuella(cadena[2]); // el registro 3 vuelve a "cuadrar"...

    assert.equal(recalcularHuella(cadena[2]), cadena[2].huella);
    // ...pero el registro 4 guardaba la huella ANTIGUA del 3.
    assert.notEqual(cadena[3].huellaAnterior, cadena[2].huella);
    assert.deepEqual(codigos(cadena, ancla), ['08@4']);
  });

  it('NIVEL 3 · además corregir el enlace del siguiente → ahora es el siguiente el que no cuadra', () => {
    const cadena = clonar(original);
    cadena[2].importeTotal = '121.00';
    cadena[2].cuotaTotal = '21.00';
    cadena[2].huella = recalcularHuella(cadena[2]);
    cadena[3].huellaAnterior = cadena[2].huella; // se "arregla" el puntero del registro 4...

    // ...pero la huella anterior forma parte del contenido hasheado del 4.
    assert.deepEqual(codigos(cadena, ancla), ['01@4']);
  });

  it('NIVEL 4 · rehacer TODA la cola → internamente perfecta, pero la última huella ya no es la conocida', () => {
    const cadena = clonar(original);
    cadena[2].importeTotal = '121.00';
    cadena[2].cuotaTotal = '21.00';
    for (let i = 2; i < cadena.length; i++) {
      if (i > 2) cadena[i].huellaAnterior = cadena[i - 1].huella;
      cadena[i].huella = recalcularHuella(cadena[i]);
    }

    // Sin referencia externa, la falsificación completa no se distingue...
    assert.equal(verificarCadena(cadena, { ahora: AHORA }).integra, true);
    // ...pero TODAS las huellas desde el registro alterado han cambiado,
    for (let i = 2; i < cadena.length; i++) assert.notEqual(cadena[i].huella, original[i].huella);
    // y las anteriores no.
    for (let i = 0; i < 2; i++) assert.equal(cadena[i].huella, original[i].huella);
    // Con el ancla (cabecera de la cadena, acuse de la AEAT, firma) queda al descubierto.
    assert.deepEqual(codigos(cadena, ancla), ['09@6']);
  });

  it('cuanto más atrás está el registro alterado, más huellas hay que falsificar', () => {
    for (let alterado = 0; alterado < original.length; alterado++) {
      const cadena = clonar(original);
      if (cadena[alterado].tipoRegistro === 'ALTA') cadena[alterado].importeTotal = '0.01';
      else cadena[alterado].numSerieFactura = 'T26-000009';
      for (let i = alterado; i < cadena.length; i++) {
        if (i > alterado) cadena[i].huellaAnterior = cadena[i - 1].huella;
        cadena[i].huella = recalcularHuella(cadena[i]);
      }
      const distintas = cadena.filter((r, i) => r.huella !== original[i].huella).length;
      assert.equal(distintas, original.length - alterado);
    }
  });
});

describe('Otras manipulaciones de la cadena', () => {
  const original = construirCadena(SEMILLAS);
  const ancla = original.at(-1)!.huella;

  it('eliminar un registro intermedio deja un hueco y un enlace roto', () => {
    const cadena = clonar(original).filter((r) => r.numSecuencia !== 3);
    assert.deepEqual(codigos(cadena, ancla), ['05@2', '08@4']);
  });

  it('eliminar el último registro solo lo descubre el ancla', () => {
    const cadena = clonar(original).slice(0, -1);
    assert.equal(verificarCadena(cadena, { ahora: AHORA }).integra, true);
    assert.deepEqual(codigos(cadena, ancla), ['09@5']);
  });

  it('insertar un registro en medio rompe el enlace del que venía después', () => {
    const cadena = clonar(original);
    const intruso: RegistroEncadenado = {
      ...cadena[1],
      numSerieFactura: 'T26-000099',
      huellaAnterior: cadena[1].huella,
      esPrimerRegistro: false,
      fechaHoraHusoGen: '2026-11-16T10:00:07+01:00',
      huella: '',
    };
    intruso.huella = recalcularHuella(intruso);
    cadena.splice(2, 0, intruso);
    cadena.forEach((r, i) => (r.numSecuencia = i + 1));
    // El intruso encadena bien con el 2, pero el antiguo 3 (ahora 4) apunta al 2, no a él.
    assert.deepEqual(codigos(cadena, ancla), ['08@4']);
  });

  it('intercambiar dos registros de sitio rompe los tres enlaces afectados', () => {
    const cadena = clonar(original);
    [cadena[1].numSecuencia, cadena[2].numSecuencia] = [cadena[2].numSecuencia, cadena[1].numSecuencia];
    // Cada registro sigue cuadrando consigo mismo (no hay 01), pero ya no con su vecino.
    assert.deepEqual(codigos(cadena, ancla), ['08@2', '08@3', '08@4']);
  });

  it('un segundo "primer registro" a mitad de cadena no cuela', () => {
    const cadena = clonar(original);
    cadena[3].esPrimerRegistro = true;
    cadena[3].huellaAnterior = null;
    cadena[3].huella = recalcularHuella(cadena[3]);
    assert.deepEqual(codigos(cadena, ancla), ['08@4', '08@5']);
  });

  it('detecta registros fechados en el futuro y marcha atrás en el tiempo', () => {
    const futuro = construirCadena(SEMILLAS);
    assert.deepEqual(
      verificarCadena(futuro, { ahora: new Date('2026-11-16T09:00:00+01:00') }).anomalias.map((a) => a.codigo),
      ['13', '13', '13', '13', '13', '13']
    );

    // Un registro "antedatado" con su huella bien calculada: no falla la integridad, falla el orden.
    const cadena = clonar(original);
    cadena[5].fechaHoraHusoGen = '2026-11-16T09:30:00+01:00';
    cadena[5].huella = recalcularHuella(cadena[5]);
    assert.deepEqual(codigos(cadena), ['11@6']);
  });

  it('una huella con formato inválido cuenta como registro no íntegro', () => {
    const cadena = clonar(original);
    cadena[5].huella = cadena[5].huella.toLowerCase();
    assert.deepEqual(codigos(cadena), ['01@6']);
  });
});
