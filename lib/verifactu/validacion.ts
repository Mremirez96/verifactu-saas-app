import { z } from 'zod';
import { ErrorDominio } from './errores';

/**
 * Valida una entrada con Zod y, si falla, lanza un `ErrorDominio` con el
 * primer mensaje (para mostrarlo tal cual) y el detalle por campo.
 */
export function validar<S extends z.ZodTypeAny>(esquema: S, entrada: unknown): z.infer<S> {
  const resultado = esquema.safeParse(entrada);
  if (!resultado.success) {
    throw new ErrorDominio('VALIDACION', resultado.error.errors[0].message, {
      campos: resultado.error.flatten().fieldErrors,
    });
  }
  return resultado.data;
}

/** Los formularios envían '' para los campos vacíos: se tratan como ausentes. */
const vacioComoAusente = (valor: unknown) =>
  typeof valor === 'string' && valor.trim() === '' ? undefined : valor;

export const textoOpcional = (max: number) =>
  z.preprocess(vacioComoAusente, z.string().trim().max(max).optional());

export const emailOpcional = z.preprocess(
  vacioComoAusente,
  z.string().trim().email('El correo electrónico no es válido').max(255).optional()
);

/** Porcentaje 0-100 con dos decimales, devuelto como texto (columna numeric). */
export const porcentajeOpcional = z.preprocess(
  vacioComoAusente,
  z.coerce
    .number({ invalid_type_error: 'El porcentaje debe ser un número' })
    .min(0, 'El porcentaje no puede ser negativo')
    .max(100, 'El porcentaje no puede superar 100')
    .transform((n) => n.toFixed(2))
    .optional()
);

/** Casilla de formulario: 'on' | 'true' | '1' | true → true. */
export const casilla = z.preprocess(
  (valor) => valor === true || valor === 'on' || valor === 'true' || valor === '1',
  z.boolean()
);

export const uuid = (nombre: string) =>
  z.string().uuid(`Identificador de ${nombre} no válido`);
