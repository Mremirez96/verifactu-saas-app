import { z } from 'zod';
import { validarNif } from '../nif';
import { emailOpcional, porcentajeOpcional, textoOpcional } from '../validacion';

/** Husos horarios del territorio español (art. 7.e Orden HAC/1177/2024). */
export const HUSOS_HORARIOS = ['Europe/Madrid', 'Atlantic/Canary', 'Africa/Ceuta'] as const;

/** Lista L1 del anexo: impuesto de aplicación. */
export const IMPUESTOS = {
  '01': 'IVA',
  '02': 'IPSI (Ceuta y Melilla)',
  '03': 'IGIC (Canarias)',
} as const;

export const altaEmpresaSchema = z
  .object({
    // El NIF se normaliza (mayúsculas, sin guiones) y se valida su control.
    nif: z.string({ required_error: 'El NIF es obligatorio' }).transform((valor, ctx) => {
      const resultado = validarNif(valor);
      if (!resultado.valido) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: resultado.motivo });
        return z.NEVER;
      }
      return resultado.nif;
    }),
    nombreRazon: z
      .string({ required_error: 'El nombre o razón social es obligatorio' })
      .trim()
      .min(1, 'El nombre o razón social es obligatorio')
      .max(120, 'El nombre o razón social admite 120 caracteres como máximo'),
    nombreComercial: textoOpcional(120),
    direccion: textoOpcional(250),
    codigoPostal: textoOpcional(10),
    municipio: textoOpcional(100),
    provincia: textoOpcional(100),
    email: emailOpcional,
    telefono: textoOpcional(30),

    modoVerifactu: z.enum(['VERIFACTU', 'NO_VERIFACTU']).default('VERIFACTU'),
    impuestoPorDefecto: z.enum(['01', '02', '03']).default('01'),
    tipoImpositivoPorDefecto: porcentajeOpcional,
    retencionIrpfPorDefecto: porcentajeOpcional,
    husoHorario: z.enum(HUSOS_HORARIOS).optional(),
  })
  .superRefine((datos, ctx) => {
    // IVA (21 %) e IGIC (7 %) tienen un tipo general conocido. El IPSI varía
    // según la operación y el territorio: no se presupone, hay que indicarlo.
    if (datos.impuestoPorDefecto === '02' && datos.tipoImpositivoPorDefecto === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tipoImpositivoPorDefecto'],
        message: 'Indique el tipo impositivo habitual de IPSI',
      });
    }
  });

export type AltaEmpresaEntrada = z.input<typeof altaEmpresaSchema>;
export type AltaEmpresaDatos = z.output<typeof altaEmpresaSchema>;
