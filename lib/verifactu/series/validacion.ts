import { z } from 'zod';
import { casilla, textoOpcional } from '../validacion';

export const TIPOS_SERIE = ['ORDINARIA', 'SIMPLIFICADA', 'RECTIFICATIVA'] as const;

/**
 * Código (prefijo) de la serie. Se guarda en mayúsculas para que "f26-" y
 * "F26-" no acaben siendo dos series distintas con números casi idénticos.
 * Juego de caracteres: subconjunto seguro de los que admite «NumSerieFactura»
 * (el mismo que comprueba el CHECK de la tabla).
 */
const codigoSerie = z
  .string({ required_error: 'El código de la serie es obligatorio' })
  .trim()
  .min(1, 'El código de la serie es obligatorio')
  .max(20, 'El código de la serie admite 20 caracteres como máximo')
  .regex(/^[A-Za-z0-9/_.\-]+$/, 'El código solo admite letras, números y los signos / _ . -')
  .transform((valor) => valor.toUpperCase());

const digitos = z.coerce
  .number({ invalid_type_error: 'El número de dígitos debe ser un número' })
  .int()
  .min(1, 'El número de dígitos debe estar entre 1 y 12')
  .max(12, 'El número de dígitos debe estar entre 1 y 12');

const ejercicio = z.preprocess(
  (valor) => (valor === '' || valor === null ? undefined : valor),
  z.coerce.number().int().min(2000, 'Ejercicio no válido').max(2100, 'Ejercicio no válido').optional()
);

export const altaSerieSchema = z.object({
  codigo: codigoSerie,
  tipoSerie: z.enum(TIPOS_SERIE, {
    errorMap: () => ({ message: 'Indique si la serie es ordinaria, simplificada o rectificativa' }),
  }),
  descripcion: textoOpcional(100),
  ejercicio,
  digitosRelleno: digitos.default(6),
  porDefecto: casilla.default(false),
});

/**
 * Cambios admitidos en una serie. El TIPO no es editable: una serie ordinaria
 * no se convierte en rectificativa; se crea otra.
 */
export const cambiosSerieSchema = z
  .object({
    codigo: codigoSerie.optional(),
    descripcion: z.string().trim().max(100).nullable().optional(),
    ejercicio,
    digitosRelleno: digitos.optional(),
    activa: z.preprocess((v) => (v === undefined ? undefined : v === true || v === 'true' || v === 'on' || v === '1'), z.boolean().optional()),
  })
  .refine((cambios) => Object.values(cambios).some((v) => v !== undefined), {
    message: 'No se ha indicado ningún cambio',
  });

export type AltaSerieDatos = z.output<typeof altaSerieSchema>;
export type CambiosSerieDatos = z.output<typeof cambiosSerieSchema>;
