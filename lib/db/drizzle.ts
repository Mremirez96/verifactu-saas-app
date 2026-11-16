import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Cliente de base de datos de la APLICACIÓN.
 *
 * Se conecta con POSTGRES_URL, que debe corresponder a un usuario miembro del
 * rol `verifactu_app`: sin superusuario, sin ser propietario de las tablas y
 * con los permisos mínimos concedidos en 0003_verifactu_privilegios.sql.
 *
 * Las migraciones NO pasan por aquí: usan POSTGRES_MIGRATION_URL (rol
 * propietario) a través de drizzle.config.ts. Ver lib/db/README.md.
 */
if (!process.env.POSTGRES_URL) {
  throw new Error('POSTGRES_URL environment variable is not set');
}

// Primera barrera, sin tocar la red: la app no puede compartir credenciales
// con el rol que migra. La comprobación real de privilegios (contra el
// catálogo de PostgreSQL) está en ./verificar-rol.ts y se lanza al arrancar.
if (
  process.env.POSTGRES_MIGRATION_URL &&
  process.env.POSTGRES_MIGRATION_URL === process.env.POSTGRES_URL
) {
  throw new Error(
    'POSTGRES_URL y POSTGRES_MIGRATION_URL son idénticas: la aplicación se ' +
      'conectaría con el rol propietario del esquema. Ver lib/db/README.md.'
  );
}

export const client = postgres(process.env.POSTGRES_URL);
export const db = drizzle(client, { schema });

/** Conexión normal o transacción en curso: los repositorios aceptan ambas. */
export type Database = typeof db;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type DbOrTx = Database | Transaction;
