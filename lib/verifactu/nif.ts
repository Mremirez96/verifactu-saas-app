/**
 * Validación de NIF españoles (formato del anexo de la Orden HAC/1177/2024:
 * «FormatoNIF (9)», nueve caracteres alfanuméricos en mayúsculas).
 *
 * Se comprueba el dígito/letra de control porque un NIF mal tecleado acaba en
 * un registro de facturación que la AEAT rechazará... y que ya no se puede
 * borrar. Validar aquí es mucho más barato que subsanar después.
 */

export type TipoNif = 'DNI' | 'NIE' | 'CIF' | 'ESPECIAL';

export type ResultadoNif =
  | { valido: true; nif: string; tipo: TipoNif }
  | { valido: false; motivo: string };

const LETRAS_DNI = 'TRWAGMYFPDXBNJZSQVHLCKE';
const CONTROL_CIF = 'JABCDEFGHI';

/** Quita espacios, puntos y guiones y pasa a mayúsculas. */
export function normalizarNif(valor: string): string {
  return valor.replace(/[\s.\-]/g, '').toUpperCase();
}

export function validarNif(valor: string): ResultadoNif {
  const nif = normalizarNif(valor);

  if (!/^[A-Z0-9]{9}$/.test(nif)) {
    return { valido: false, motivo: 'El NIF debe tener 9 caracteres alfanuméricos' };
  }

  // --- DNI: 8 dígitos + letra = resto de dividir el número entre 23 ---
  if (/^\d{8}[A-Z]$/.test(nif)) {
    const letra = LETRAS_DNI[Number(nif.slice(0, 8)) % 23];
    return letra === nif[8]
      ? { valido: true, nif, tipo: 'DNI' }
      : { valido: false, motivo: 'La letra del DNI no es correcta' };
  }

  // --- NIE: X/Y/Z + 7 dígitos + letra; X→0, Y→1, Z→2 y se calcula como un DNI ---
  if (/^[XYZ]\d{7}[A-Z]$/.test(nif)) {
    const numero = Number('XYZ'.indexOf(nif[0]) + nif.slice(1, 8));
    return LETRAS_DNI[numero % 23] === nif[8]
      ? { valido: true, nif, tipo: 'NIE' }
      : { valido: false, motivo: 'La letra del NIE no es correcta' };
  }

  // --- NIF de persona jurídica o entidad (antiguo CIF) ---
  if (/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(nif)) {
    const digitos = nif.slice(1, 8).split('').map(Number);
    let suma = 0;
    digitos.forEach((d, i) => {
      if (i % 2 === 0) {
        // Posiciones impares (1ª, 3ª, 5ª, 7ª): se duplica y se suman sus cifras.
        const doble = d * 2;
        suma += Math.floor(doble / 10) + (doble % 10);
      } else {
        suma += d;
      }
    });
    const control = (10 - (suma % 10)) % 10;
    const esperadoDigito = String(control);
    const esperadoLetra = CONTROL_CIF[control];
    const real = nif[8];

    // Según la letra inicial, el control es obligatoriamente letra, dígito o
    // se admite cualquiera de los dos.
    const soloLetra = 'PQRSNW'.includes(nif[0]);
    const soloDigito = 'ABEH'.includes(nif[0]);
    const correcto = soloLetra
      ? real === esperadoLetra
      : soloDigito
        ? real === esperadoDigito
        : real === esperadoDigito || real === esperadoLetra;

    return correcto
      ? { valido: true, nif, tipo: 'CIF' }
      : { valido: false, motivo: 'El carácter de control del NIF no es correcto' };
  }

  // --- NIF especiales K, L, M (menores, residentes en el extranjero, extranjeros
  // sin NIE). Son muy poco frecuentes como emisores: aquí solo se valida el
  // formato, no el carácter de control.
  if (/^[KLM]\d{7}[A-Z]$/.test(nif)) {
    return { valido: true, nif, tipo: 'ESPECIAL' };
  }

  return { valido: false, motivo: 'El formato del NIF no es válido' };
}
