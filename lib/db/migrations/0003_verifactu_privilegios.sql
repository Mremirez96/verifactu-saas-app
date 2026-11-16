-- =============================================================================
-- 0003_verifactu_privilegios.sql
-- Rol de aplicación con privilegios acotados.
--
-- Migración escrita a mano (drizzle-kit generate --custom): drizzle-kit no
-- gestiona roles ni permisos, así que este fichero NO se regenera desde
-- schema.ts.
--
-- PROBLEMA QUE RESUELVE
--   Los triggers de 0002 se pueden desactivar con ALTER TABLE ... DISABLE
--   TRIGGER (lo puede hacer el propietario de la tabla) o con
--   session_replication_role (lo puede hacer un superusuario). Si la aplicación
--   se conectara con cualquiera de esos dos roles, las guardas serían
--   opcionales.
--
-- MODELO DE DOS ROLES
--   · Propietario  → el rol que ejecuta ESTA migración (POSTGRES_MIGRATION_URL).
--                    Dueño de tablas, funciones y triggers. Solo migra.
--   · verifactu_app → rol de GRUPO sin login. Reúne los permisos de ejecución.
--                    El usuario con contraseña que usa la app (POSTGRES_URL)
--                    es miembro de este grupo y lo crea `pnpm db:roles`; así
--                    ninguna contraseña queda escrita en una migración.
--
-- PRINCIPIO: lo que la aplicación no necesita hacer, no puede hacerlo.
--   Los permisos se conceden tabla a tabla. No hay ALTER DEFAULT PRIVILEGES:
--   una tabla nueva es inaccesible para la app hasta que una migración le
--   concede permisos de forma explícita.
--
-- OJO: no escribir el marcador de corte de drizzle-kit (el de la flecha)
-- dentro de comentarios; ver la nota de 0002.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Rol de grupo
--    Requiere que el rol propietario tenga CREATEROLE. Si no lo tiene, un DBA
--    debe crear antes `verifactu_app` con estos mismos atributos y esta
--    sentencia no hará nada.
-- -----------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'verifactu_app') THEN
    CREATE ROLE verifactu_app
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;
--> statement-breakpoint

-- La app no crea objetos. En PostgreSQL 15+ PUBLIC ya no tiene CREATE sobre
-- el esquema public; en versiones anteriores se retira aquí si se puede.
DO $$
BEGIN
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'No se pudo retirar CREATE sobre el esquema public a PUBLIC; revíselo un DBA';
END;
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO verifactu_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 2. Tablas del starter (usuarios, cuentas, actividad): lectura y escritura
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE
  ON users, teams, team_members, activity_logs, invitations
  TO verifactu_app;
--> statement-breakpoint
GRANT USAGE, SELECT
  ON SEQUENCE users_id_seq, teams_id_seq, team_members_id_seq,
              activity_logs_id_seq, invitations_id_seq
  TO verifactu_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 3. Tablas fiscales: permisos mínimos, una a una
--    (TRUNCATE, REFERENCES y TRIGGER no se conceden en ninguna)
-- -----------------------------------------------------------------------------

-- Empresas: se crean y se editan; nunca se borran.
GRANT SELECT, INSERT, UPDATE ON empresas TO verifactu_app;
--> statement-breakpoint

-- Clientes: CRUD completo (el borrado con facturas lo impide la FK).
GRANT SELECT, INSERT, UPDATE, DELETE ON clientes TO verifactu_app;
--> statement-breakpoint

-- Series: la app NO tiene permiso de UPDATE sobre el contador
-- (ultimo_numero, ultima_fecha_expedicion). Solo lo mueve el trigger de
-- emisión, que se ejecuta con los permisos del propietario (apartado 4).
GRANT SELECT, INSERT, DELETE ON series_facturacion TO verifactu_app;
--> statement-breakpoint
GRANT UPDATE (codigo, descripcion, tipo_serie, ejercicio, digitos_relleno, por_defecto, activa)
  ON series_facturacion TO verifactu_app;
--> statement-breakpoint

-- Facturas y su detalle: el ciclo de vida lo gobiernan los triggers de 0002.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON facturas, facturas_lineas, facturas_desglose, facturas_relacionadas
  TO verifactu_app;
--> statement-breakpoint

-- Registros de facturación y de evento: SOLO leer e insertar. Además del
-- trigger que lo prohíbe, la app ni siquiera tiene el permiso de UPDATE/DELETE.
GRANT SELECT, INSERT ON registros_verifactu, eventos_log TO verifactu_app;
--> statement-breakpoint

-- Cola AEAT: la fila la inserta el trigger; la app solo actualiza el estado
-- del envío. Las columnas de identidad no son actualizables.
GRANT SELECT ON envios_aeat TO verifactu_app;
--> statement-breakpoint
GRANT UPDATE (estado, intentos, proximo_intento_en, lote_id, enviado_en, respondido_en,
              csv, codigo_error, descripcion_error, respuesta_aeat, updated_at)
  ON envios_aeat TO verifactu_app;
--> statement-breakpoint

-- Cabeceras de cadena: solo lectura. Para bloquear la cadena se usa
-- vf_bloquear_cadena() (apartado 5).
GRANT SELECT ON cadenas_fiscales TO verifactu_app;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 4. Triggers que escriben donde la app no puede: SECURITY DEFINER
--
--    Una función de trigger se ejecuta, por defecto, con los permisos de quien
--    lanza la sentencia. Estas cinco tocan tablas o columnas vetadas a la app
--    (cadenas_fiscales, envios_aeat, el contador de las series), así que pasan
--    a ejecutarse con los permisos de su propietario. Se fija search_path para
--    que no puedan ser engañadas con objetos homónimos en otro esquema.
-- -----------------------------------------------------------------------------
ALTER FUNCTION vf_empresas_crear_cadenas() SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION vf_facturas_guard()         SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION vf_registros_encadenar()    SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION vf_registros_encolar()      SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION vf_eventos_encadenar()      SECURITY DEFINER SET search_path = public, pg_temp;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- 5. Cerrojo de cadena para el motor criptográfico
--
--    SELECT ... FOR UPDATE exige permiso de UPDATE, que la app no tiene sobre
--    cadenas_fiscales. Esta función toma el cerrojo en su nombre y devuelve la
--    cabecera (último id, última huella). El bloqueo dura hasta el final de la
--    transacción: quien la llama tiene la cadena de ESA empresa en exclusiva
--    mientras calcula la huella e inserta el registro.
--
--      BEGIN;
--        SELECT * FROM vf_bloquear_cadena($empresa, 'FACTURACION');
--        -- calcular huella con ultima_huella
--        INSERT INTO registros_verifactu (...);
--      COMMIT;
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_bloquear_cadena(p_empresa_id uuid, p_tipo tipo_cadena)
RETURNS SETOF cadenas_fiscales
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT *
    FROM cadenas_fiscales
   WHERE empresa_id = p_empresa_id AND tipo_cadena = p_tipo
     FOR UPDATE;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION vf_bloquear_cadena(uuid, tipo_cadena) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION vf_bloquear_cadena(uuid, tipo_cadena) TO verifactu_app;
