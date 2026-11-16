import type postgres from 'postgres';

/**
 * Comprueba, contra el catálogo de PostgreSQL, que el rol con el que se ha
 * conectado la aplicación NO puede saltarse las guardas VERI*FACTU.
 *
 * Los triggers de integridad son tan fuertes como el rol que los sufre:
 *   · un superusuario puede anularlos con `session_replication_role`,
 *   · el propietario de una tabla puede hacer ALTER TABLE ... DISABLE TRIGGER,
 *   · un rol con UPDATE/DELETE/TRUNCATE sobre los registros no depende de ellos.
 * Por eso aquí no se confía en la configuración: se pregunta a la base de
 * datos qué puede hacer realmente `current_user`.
 */

export type DiagnosticoRol = {
  rol: string;
  /** Lista vacía = rol correctamente acotado. */
  problemas: string[];
};

type FilaDiagnostico = {
  rol: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  esquema_migrado: boolean;
  tablas_como_propietario: number;
  crea_en_public: boolean;
};

type FilaPermisos = {
  modifica_registros: boolean;
  modifica_eventos: boolean;
  trunca_facturas: boolean;
  borra_empresas: boolean;
  escribe_cadenas: boolean;
  escribe_cola: boolean;
  mueve_contador: boolean;
  borra_lotes: boolean;
  escribe_control_flujo: boolean;
};

export async function diagnosticarRol(sql: postgres.Sql): Promise<DiagnosticoRol> {
  const [f] = await sql<FilaDiagnostico[]>`
    SELECT current_user::text AS rol,
           r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
           to_regclass('public.registros_verifactu') IS NOT NULL AS esquema_migrado,
           -- Tablas de public de las que el rol es dueño, directa o indirectamente
           -- (pg_has_role cubre la pertenencia al rol propietario y el SET ROLE).
           (SELECT count(*)::int
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
               AND pg_has_role(current_user, c.relowner, 'MEMBER')) AS tablas_como_propietario,
           has_schema_privilege(current_user, 'public', 'CREATE') AS crea_en_public
      FROM pg_roles r
     WHERE r.rolname = current_user`;

  const problemas: string[] = [];

  if (f.rolsuper) problemas.push('es SUPERUSUARIO (puede desactivar todos los triggers)');
  if (f.rolbypassrls) problemas.push('tiene BYPASSRLS');
  if (f.rolcreaterole) problemas.push('tiene CREATEROLE (puede concederse otros roles)');
  if (f.rolcreatedb) problemas.push('tiene CREATEDB');
  if (f.rolreplication) problemas.push('tiene REPLICATION');
  if (f.tablas_como_propietario > 0) {
    problemas.push(
      `es propietario (o miembro del propietario) de ${f.tablas_como_propietario} tabla(s): ` +
        'puede hacer ALTER TABLE ... DISABLE TRIGGER'
    );
  }
  if (f.crea_en_public) problemas.push('puede crear objetos en el esquema public');

  if (!f.esquema_migrado) {
    problemas.push('el esquema VERI*FACTU no está migrado (ejecute pnpm db:migrate)');
    return { rol: f.rol, problemas };
  }

  const [p] = await sql<FilaPermisos[]>`
    SELECT has_table_privilege(current_user, 'registros_verifactu', 'UPDATE, DELETE, TRUNCATE') AS modifica_registros,
           has_table_privilege(current_user, 'eventos_log',         'UPDATE, DELETE, TRUNCATE') AS modifica_eventos,
           has_table_privilege(current_user, 'facturas',            'TRUNCATE')                 AS trunca_facturas,
           has_table_privilege(current_user, 'empresas',            'DELETE, TRUNCATE')         AS borra_empresas,
           has_table_privilege(current_user, 'cadenas_fiscales',    'INSERT, UPDATE, DELETE, TRUNCATE') AS escribe_cadenas,
           has_table_privilege(current_user, 'envios_aeat',         'INSERT, DELETE, TRUNCATE') AS escribe_cola,
           has_column_privilege(current_user, 'series_facturacion', 'ultimo_numero', 'UPDATE')  AS mueve_contador,
           -- Tablas de la remisión a la AEAT (Fase 4); se ignoran si aún no están migradas.
           CASE WHEN to_regclass('public.aeat_lotes') IS NULL THEN false
                ELSE has_table_privilege(current_user, 'aeat_lotes', 'DELETE, TRUNCATE') END     AS borra_lotes,
           CASE WHEN to_regclass('public.aeat_control_flujo') IS NULL THEN false
                ELSE has_table_privilege(current_user, 'aeat_control_flujo', 'INSERT, DELETE, TRUNCATE') END AS escribe_control_flujo`;

  if (p.modifica_registros) problemas.push('puede modificar o borrar registros_verifactu');
  if (p.modifica_eventos) problemas.push('puede modificar o borrar eventos_log');
  if (p.trunca_facturas) problemas.push('puede hacer TRUNCATE de facturas');
  if (p.borra_empresas) problemas.push('puede borrar empresas');
  if (p.escribe_cadenas) problemas.push('puede escribir directamente en cadenas_fiscales');
  if (p.escribe_cola) problemas.push('puede insertar o borrar en envios_aeat');
  if (p.mueve_contador) problemas.push('puede mover el contador de las series');
  if (p.borra_lotes) problemas.push('puede borrar la evidencia de los envíos (aeat_lotes)');
  if (p.escribe_control_flujo) problemas.push('puede insertar o borrar en aeat_control_flujo');

  return { rol: f.rol, problemas };
}

/**
 * Se llama una vez al arrancar el servidor (instrumentation.ts).
 *   · Producción: si el rol es excesivo, la aplicación NO arranca.
 *   · Desarrollo: avisa de forma visible y continúa.
 */
export async function verificarRolBaseDatos(): Promise<void> {
  const { client } = await import('./drizzle');
  const { rol, problemas } = await diagnosticarRol(client);

  if (problemas.length === 0) {
    console.info(`[verifactu] Rol de base de datos "${rol}" verificado: privilegios acotados.`);
    return;
  }

  const mensaje =
    `[verifactu] El rol de base de datos "${rol}" NO es apto para ejecutar la aplicación:\n` +
    problemas.map((p) => `  - ${p}`).join('\n') +
    '\nPOSTGRES_URL debe usar un usuario miembro de "verifactu_app" (pnpm db:roles). ' +
    'Ver lib/db/README.md.';

  if (process.env.NODE_ENV === 'production') {
    throw new Error(mensaje);
  }
  console.warn(mensaje);
}
