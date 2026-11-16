import type { Config } from 'drizzle-kit';

/**
 * drizzle-kit (generate / migrate / studio) se conecta SIEMPRE con el rol
 * PROPIETARIO del esquema, nunca con el de la aplicación.
 *
 *   POSTGRES_MIGRATION_URL → rol propietario: crea tablas, triggers y permisos.
 *   POSTGRES_URL           → rol de la aplicación (privilegios acotados).
 *
 * No hay valor por defecto a propósito: si las migraciones cayeran sobre
 * POSTGRES_URL, las tablas pasarían a ser propiedad del rol de la aplicación
 * y este podría desactivar los triggers de integridad VERI*FACTU.
 */
const url = process.env.POSTGRES_MIGRATION_URL;

if (!url) {
  throw new Error(
    'Falta POSTGRES_MIGRATION_URL (rol propietario del esquema). ' +
      'Las migraciones no se ejecutan con POSTGRES_URL. Ver lib/db/README.md.'
  );
}

export default {
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
} satisfies Config;
