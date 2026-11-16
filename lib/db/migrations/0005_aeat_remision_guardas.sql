-- =============================================================================
-- 0005_aeat_remision_guardas.sql
-- Guardas y permisos de la remisión a la AEAT (Fase 4).
--
-- Migración escrita a mano (drizzle-kit generate --custom). Complementa a
-- 0004_aeat_remision_modelo.sql, que sí se genera desde schema.ts.
--
--   A. Cada empresa nace con su fila de control de flujo.
--   B. Un mensaje (lote) cerrado es evidencia: ya no se modifica ni se borra.
--   C. Cola de envíos: transiciones de estado permitidas. En particular, un
--      registro VERI*FACTU pendiente no puede "desaparecer" de la cola
--      pasándolo a NO_APLICA, y un registro NO VERI*FACTU no puede entrar.
--   D. Permisos del rol de la aplicación sobre las tablas nuevas.
--
-- OJO: no escribir el marcador de corte de drizzle-kit (el de la flecha)
-- dentro de comentarios ni de cuerpos $$; ver la nota de 0002.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Control de flujo: una fila por empresa, creada por trigger
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_empresas_crear_control_flujo() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO aeat_control_flujo (empresa_id) VALUES (NEW.id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER empresas_crear_control_flujo
  AFTER INSERT ON empresas
  FOR EACH ROW EXECUTE FUNCTION vf_empresas_crear_control_flujo();
--> statement-breakpoint

-- Empresas que ya existían antes de esta migración. Va ANTES de crear la
-- guarda de inserción, que a partir de aquí solo deja insertar al trigger.
INSERT INTO aeat_control_flujo (empresa_id)
SELECT e.id FROM empresas e
 WHERE NOT EXISTS (SELECT 1 FROM aeat_control_flujo c WHERE c.empresa_id = e.id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION vf_aeat_control_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Solo la crea el trigger de empresas.
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'VERIFACTU: aeat_control_flujo se crea sola al dar de alta la empresa'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.empresa_id <> OLD.empresa_id THEN
    RAISE EXCEPTION 'VERIFACTU: el control de flujo no puede cambiar de empresa'
      USING ERRCODE = 'restrict_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER aeat_control_guard
  BEFORE INSERT OR UPDATE ON aeat_control_flujo
  FOR EACH ROW EXECUTE FUNCTION vf_aeat_control_guard();
--> statement-breakpoint
CREATE TRIGGER aeat_control_no_delete
  BEFORE DELETE ON aeat_control_flujo
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER aeat_control_no_truncate
  BEFORE TRUNCATE ON aeat_control_flujo
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- B. Lotes: la identidad no cambia y un lote cerrado es inalterable
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_aeat_lotes_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  resultado_cols text[] := ARRAY['resultado', 'estado_http', 'csv', 'tiempo_espera_seg', 'codigo_error',
                                 'descripcion_error', 'respuesta_xml', 'resultado_registros', 'finalizado_en'];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.resultado <> 'EN_CURSO' THEN
      RAISE EXCEPTION 'VERIFACTU: un lote nace EN_CURSO, antes de salir a la red'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.resultado <> 'EN_CURSO' THEN
    RAISE EXCEPTION 'VERIFACTU: el lote % ya está cerrado (%) y es evidencia de la remisión: no se modifica',
      OLD.id, OLD.resultado
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF (to_jsonb(NEW) - resultado_cols) IS DISTINCT FROM (to_jsonb(OLD) - resultado_cols) THEN
    RAISE EXCEPTION 'VERIFACTU: de un lote solo se puede registrar su resultado'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER aeat_lotes_guard
  BEFORE INSERT OR UPDATE ON aeat_lotes
  FOR EACH ROW EXECUTE FUNCTION vf_aeat_lotes_guard();
--> statement-breakpoint
CREATE TRIGGER aeat_lotes_no_delete
  BEFORE DELETE ON aeat_lotes
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER aeat_lotes_no_truncate
  BEFORE TRUNCATE ON aeat_lotes
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- C. Cola de envíos: máquina de estados
--
--      PENDIENTE ─┐                       ┌─► ACEPTADO
--                 ├─► ENVIANDO ───────────┼─► ACEPTADO_CON_ERRORES     (finales)
--   ERROR_TRANSITORIO ◄──── (fallo técnico)└─► RECHAZADO
--
--      NO_APLICA  (registro generado en modo NO VERI*FACTU: final desde que nace)
--
--   Sustituye a la función de 0002 conservando sus comprobaciones y añade:
--     · nadie entra en NO_APLICA ni en PENDIENTE desde otro estado: son los
--       estados de nacimiento, que fija el trigger de encolado según el modo
--       del registro. Así un registro VERI*FACTU pendiente no puede retirarse
--       de la cola, ni uno NO VERI*FACTU colarse en ella;
--     · a un estado final solo se llega desde un envío realmente intentado.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_envios_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'VERIFACTU: la cola de envíos se alimenta sola al insertar un registro'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.registro_id, NEW.empresa_id, NEW.num_secuencia)
       IS DISTINCT FROM (OLD.registro_id, OLD.empresa_id, OLD.num_secuencia) THEN
    RAISE EXCEPTION 'VERIFACTU: un envío no puede reasignarse a otro registro'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.estado <> OLD.estado THEN
    -- Estados finales: la respuesta de la AEAT ya no se reescribe. Una
    -- corrección posterior es siempre un NUEVO registro (subsanación).
    IF OLD.estado IN ('NO_APLICA', 'ACEPTADO', 'ACEPTADO_CON_ERRORES', 'RECHAZADO') THEN
      RAISE EXCEPTION 'VERIFACTU: el envío está en estado final (%) y no admite cambios de estado', OLD.estado
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.estado IN ('NO_APLICA', 'PENDIENTE') THEN
      RAISE EXCEPTION 'VERIFACTU: transición de envío no permitida (% → %): el estado inicial lo fija el modo del registro',
        OLD.estado, NEW.estado
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.estado IN ('ACEPTADO', 'ACEPTADO_CON_ERRORES', 'RECHAZADO') AND OLD.intentos = 0 THEN
      RAISE EXCEPTION 'VERIFACTU: el envío no puede cerrarse (%) sin haberse intentado', NEW.estado
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  IF NEW.intentos < OLD.intentos THEN
    RAISE EXCEPTION 'VERIFACTU: el contador de intentos de un envío no retrocede'
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- D. Permisos del rol de la aplicación (sin privilegios por defecto: una
--    tabla nueva es inaccesible hasta que se le conceden aquí)
-- -----------------------------------------------------------------------------

-- Lotes: se insertan y se cierran; no se borran.
GRANT SELECT, INSERT ON aeat_lotes TO verifactu_app;
--> statement-breakpoint
GRANT UPDATE (resultado, estado_http, csv, tiempo_espera_seg, codigo_error, descripcion_error,
              respuesta_xml, resultado_registros, finalizado_en)
  ON aeat_lotes TO verifactu_app;
--> statement-breakpoint

-- Control de flujo: la fila la crea el trigger; la app la lee, la bloquea
-- (SELECT ... FOR UPDATE exige UPDATE sobre alguna columna) y la actualiza.
GRANT SELECT ON aeat_control_flujo TO verifactu_app;
--> statement-breakpoint
GRANT UPDATE (tiempo_espera_seg, ultimo_envio_en, proximo_envio_en, fallos_consecutivos, incidencia_desde,
              ultimo_error_codigo, ultimo_error, requiere_intervencion, lote_en_curso_id,
              lote_en_curso_caduca_en, updated_at)
  ON aeat_control_flujo TO verifactu_app;
--> statement-breakpoint

-- Cola: columna nueva de 0004.
GRANT UPDATE (entrega_incierta) ON envios_aeat TO verifactu_app;
