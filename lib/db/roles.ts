/**
 * pnpm db:roles
 *
 * Crea (o actualiza) el USUARIO con el que se conecta la aplicación y lo hace
 * miembro del rol de grupo `verifactu_app`, que es quien tiene los permisos.
 *
 *   · Se conecta con POSTGRES_MIGRATION_URL (rol propietario, con CREATEROLE).
 *   · Toma el nombre de usuario y la contraseña de POSTGRES_URL, de modo que
 *     el .env es la única fuente de verdad y ninguna contraseña se escribe en
 *     una migración ni en el repositorio.
 *   · Al terminar se conecta COMO la aplicación y comprueba sus privilegios.
 *
 * Es idempotente: puede ejecutarse tantas veces como haga falta (por ejemplo,
 * para rotar la contraseña tras cambiarla en POSTGRES_URL).
 * Orden habitual:  pnpm db:migrate  →  pnpm db:roles  →  pnpm db:seed
 */
import postgres from 'postgres';
import dotenv from 'dotenv';
import { diagnosticarRol } from './verificar-rol';

dotenv.config();

const ROL_GRUPO = 'verifactu_app';

async function main() {
  const urlMigracion = process.env.POSTGRES_MIGRATION_URL;
  const urlApp = process.env.POSTGRES_URL;
  if (!urlMigracion || !urlApp) {
    throw new Error('Hacen falta POSTGRES_MIGRATION_URL y POSTGRES_URL en el entorno.');
  }

  const app = new URL(urlApp);
  const usuarioApp = decodeURIComponent(app.username);
  const claveApp = decodeURIComponent(app.password);
  const usuarioMigracion = decodeURIComponent(new URL(urlMigracion).username);

  if (!usuarioApp || !claveApp) {
    throw new Error('POSTGRES_URL debe incluir usuario y contraseña.');
  }
  if (usuarioApp === usuarioMigracion) {
    throw new Error(
      `POSTGRES_URL y POSTGRES_MIGRATION_URL usan el mismo usuario ("${usuarioApp}"). ` +
        'La aplicación necesita un usuario propio, distinto del propietario del esquema.'
    );
  }
  if (usuarioApp === ROL_GRUPO) {
    throw new Error(`"${ROL_GRUPO}" es el rol de grupo (sin login). Elija otro nombre de usuario, p. ej. "${ROL_GRUPO}_login".`);
  }

  const admin = postgres(urlMigracion, { max: 1, onnotice: () => {} });
  try {
    const [grupo] = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${ROL_GRUPO}`;
    if (!grupo) {
      throw new Error(`No existe el rol "${ROL_GRUPO}". Ejecute antes: pnpm db:migrate`);
    }

    const [existe] = await admin`SELECT 1 FROM pg_roles WHERE rolname = ${usuarioApp}`;
    // CREATE/ALTER ROLE no admiten parámetros: la sentencia se compone en el
    // servidor con format(), que entrecomilla identificador (%I) y literal (%L).
    //
    // Si el usuario ya existe solo se renueva la contraseña: PostgreSQL no deja
    // a un rol sin superusuario tocar atributos como SUPERUSER o BYPASSRLS, ni
    // siquiera para retirarlos. Que no los tenga lo garantiza la verificación
    // final de este script.
    const [{ ddl }] = await admin<{ ddl: string }[]>`
      SELECT format(${
        existe
          ? 'ALTER ROLE %I WITH LOGIN PASSWORD %L'
          : 'CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L'
      }, ${usuarioApp}::text, ${claveApp}::text) AS ddl`;
    await admin.unsafe(ddl);

    const [{ concesion }] = await admin<{ concesion: string }[]>`
      SELECT format('GRANT %I TO %I', ${ROL_GRUPO}::text, ${usuarioApp}::text) AS concesion`;
    await admin.unsafe(concesion);

    console.log(`Usuario "${usuarioApp}" ${existe ? 'actualizado' : 'creado'} como miembro de "${ROL_GRUPO}".`);
  } finally {
    await admin.end();
  }

  // Comprobación final desde el punto de vista de la aplicación.
  const comoApp = postgres(urlApp, { max: 1 });
  try {
    const { rol, problemas } = await diagnosticarRol(comoApp);
    if (problemas.length > 0) {
      throw new Error(
        `El rol "${rol}" sigue teniendo privilegios excesivos:\n` +
          problemas.map((p) => `  - ${p}`).join('\n')
      );
    }
    console.log(`Verificado: "${rol}" se conecta y tiene los privilegios acotados.`);
  } finally {
    await comoApp.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
