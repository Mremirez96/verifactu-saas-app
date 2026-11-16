-- =============================================================================
-- 0002_verifactu_guardas.sql
-- Guardas de integridad VERI*FACTU a nivel de base de datos.
--
-- Complementa a schema.ts con lo que un ORM no puede expresar:
--   A. Tablas de solo inserción (registros y eventos): ni UPDATE, ni DELETE,
--      ni TRUNCATE.
--   B. Facturas: borrado físico imposible tras emitir; contenido congelado.
--   C. Numeración correlativa sin saltos, asignada por la base de datos.
--   D. Encadenamiento: cada registro enlaza con el último de SU empresa.
--   E. Ninguna factura emitida sin registro de alta (comprobado al COMMIT).
--   F. Encolado automático de la remisión a la AEAT.
--
-- Migración escrita a mano (drizzle-kit generate --custom): drizzle-kit no
-- gestiona triggers, así que este fichero NO se regenera desde schema.ts.
--
-- OJO: las líneas "statement-breakpoint" son el separador de sentencias de
-- drizzle-kit, que trocea el fichero por ese texto literal. Van entre
-- sentencias completas; no escribir nunca ese marcador (con su flecha) dentro
-- de un comentario ni de un cuerpo $$, o la migración se parte por la mitad.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- A. Función genérica: prohíbe la operación sobre tablas de solo inserción
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_prohibir_modificacion() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VERIFACTU: operación % prohibida sobre "%": los datos fiscales son inalterables',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Empresas: al crearse nacen sus dos cadenas (facturación y eventos).
-- No se borran, y su identidad fiscal queda fijada.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_empresas_crear_cadenas() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO cadenas_fiscales (empresa_id, tipo_cadena)
  VALUES (NEW.id, 'FACTURACION'), (NEW.id, 'EVENTOS');
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER empresas_crear_cadenas
  AFTER INSERT ON empresas
  FOR EACH ROW EXECUTE FUNCTION vf_empresas_crear_cadenas();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION vf_empresas_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.nif <> OLD.nif
     OR NEW.numero_instalacion <> OLD.numero_instalacion THEN
    RAISE EXCEPTION 'VERIFACTU: el NIF y el número de instalación de una empresa no se pueden modificar'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER empresas_guard
  BEFORE UPDATE ON empresas
  FOR EACH ROW EXECUTE FUNCTION vf_empresas_guard();
--> statement-breakpoint
CREATE TRIGGER empresas_no_delete
  BEFORE DELETE ON empresas
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER empresas_no_truncate
  BEFORE TRUNCATE ON empresas
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- Cabeceras de cadena: solo las escriben los triggers de este fichero.
-- pg_trigger_depth() vale 1 cuando la sentencia viene directamente de la
-- aplicación y >= 2 cuando la ejecuta otro trigger.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_cadenas_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'VERIFACTU: cadenas_fiscales solo la mantienen los triggers de encadenamiento'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cadenas_guard
  BEFORE INSERT OR UPDATE ON cadenas_fiscales
  FOR EACH ROW EXECUTE FUNCTION vf_cadenas_guard();
--> statement-breakpoint
CREATE TRIGGER cadenas_no_delete
  BEFORE DELETE ON cadenas_fiscales
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER cadenas_no_truncate
  BEFORE TRUNCATE ON cadenas_fiscales
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- C. Series: el contador solo lo mueve la emisión de facturas
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_series_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Toda serie empieza en cero, diga lo que diga la aplicación.
    NEW.ultimo_numero := 0;
    NEW.ultima_fecha_expedicion := NULL;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.ultimo_numero > 0 THEN
      RAISE EXCEPTION 'VERIFACTU: la serie "%" ya tiene facturas emitidas y no se puede borrar', OLD.codigo
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE
  IF NEW.empresa_id <> OLD.empresa_id THEN
    RAISE EXCEPTION 'VERIFACTU: una serie no puede cambiar de empresa'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF OLD.ultimo_numero > 0
     AND (NEW.codigo, NEW.digitos_relleno, NEW.tipo_serie)
         IS DISTINCT FROM (OLD.codigo, OLD.digitos_relleno, OLD.tipo_serie) THEN
    RAISE EXCEPTION 'VERIFACTU: la serie "%" ya está en uso; su código, formato y tipo son inalterables', OLD.codigo
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF (NEW.ultimo_numero, NEW.ultima_fecha_expedicion)
       IS DISTINCT FROM (OLD.ultimo_numero, OLD.ultima_fecha_expedicion)
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'VERIFACTU: el contador de la serie solo avanza al emitir una factura'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER series_guard
  BEFORE INSERT OR UPDATE OR DELETE ON series_facturacion
  FOR EACH ROW EXECUTE FUNCTION vf_series_guard();
--> statement-breakpoint
CREATE TRIGGER series_no_truncate
  BEFORE TRUNCATE ON series_facturacion
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- B + C. Facturas: ciclo de vida, numeración e inalterabilidad
--
--   INSERT            → siempre como BORRADOR y sin número.
--   BORRADOR→BORRADOR → edición libre.
--   BORRADOR→EMITIDA  → la BD bloquea la serie, asigna el siguiente número,
--                       compone NumSerieFactura y avanza el contador.
--   EMITIDA / ANULADA → solo cambian las columnas de gestión (cobro) y el
--                       paso EMITIDA→ANULADA. Todo lo demás está congelado.
--   DELETE            → solo borradores.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_facturas_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  s         series_facturacion%ROWTYPE;
  -- Columnas que SÍ pueden cambiar en una factura ya emitida.
  mutables  text[] := ARRAY['estado', 'estado_cobro', 'cobrada_en', 'anulada_en', 'updated_at'];
BEGIN
  ----------------------------------------------------------------- INSERT
  IF TG_OP = 'INSERT' THEN
    IF NEW.estado <> 'BORRADOR' OR NEW.numero IS NOT NULL OR NEW.num_serie_factura IS NOT NULL THEN
      RAISE EXCEPTION 'VERIFACTU: una factura nace como BORRADOR y sin número; se emite con UPDATE estado = ''EMITIDA'''
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  ----------------------------------------------------------------- DELETE
  IF TG_OP = 'DELETE' THEN
    IF OLD.estado <> 'BORRADOR' THEN
      RAISE EXCEPTION 'VERIFACTU: la factura % está emitida y no se puede borrar; use una rectificativa o un registro de anulación',
        OLD.num_serie_factura
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  ----------------------------------------------------------------- UPDATE
  IF NEW.id <> OLD.id OR NEW.empresa_id <> OLD.empresa_id THEN
    RAISE EXCEPTION 'VERIFACTU: una factura no puede cambiar de identidad ni de empresa'
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- 1) Sigue siendo borrador: edición libre (el número sigue vacío por CHECK).
  IF OLD.estado = 'BORRADOR' AND NEW.estado = 'BORRADOR' THEN
    RETURN NEW;
  END IF;

  -- 2) EMISIÓN: aquí se asigna el número.
  IF OLD.estado = 'BORRADOR' AND NEW.estado = 'EMITIDA' THEN
    -- Bloqueo de la fila de la serie: dos emisiones simultáneas de la misma
    -- serie se ponen en fila; nunca obtienen el mismo número.
    SELECT * INTO s
      FROM series_facturacion
     WHERE id = NEW.serie_id AND empresa_id = NEW.empresa_id
       FOR UPDATE;

    IF NOT FOUND OR NOT s.activa THEN
      RAISE EXCEPTION 'VERIFACTU: la serie indicada no existe o no está activa'
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Las rectificativas van en serie específica (art. 6.1.a RD 1619/2012).
    IF (s.tipo_serie = 'RECTIFICATIVA') <> (NEW.tipo_factura IN ('R1','R2','R3','R4','R5')) THEN
      RAISE EXCEPTION 'VERIFACTU: tipo de factura % incompatible con la serie "%" (%)',
        NEW.tipo_factura, s.codigo, s.tipo_serie
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.fecha_expedicion IS NULL THEN
      RAISE EXCEPTION 'VERIFACTU: falta la fecha de expedición'
        USING ERRCODE = 'check_violation';
    END IF;

    -- Numeración y fechas correlativas dentro de la serie.
    IF s.ultima_fecha_expedicion IS NOT NULL AND NEW.fecha_expedicion < s.ultima_fecha_expedicion THEN
      RAISE EXCEPTION 'VERIFACTU: la fecha de expedición (%) es anterior a la de la última factura de la serie (%)',
        NEW.fecha_expedicion, s.ultima_fecha_expedicion
        USING ERRCODE = 'check_violation';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM facturas_lineas l WHERE l.factura_id = NEW.id) THEN
      RAISE EXCEPTION 'VERIFACTU: no se puede emitir una factura sin líneas'
        USING ERRCODE = 'check_violation';
    END IF;

    NEW.numero            := s.ultimo_numero + 1;
    NEW.num_serie_factura := s.codigo || lpad(NEW.numero::text,
                               greatest(s.digitos_relleno, length(NEW.numero::text)), '0');
    NEW.emitida_en        := now();
    NEW.updated_at        := now();

    UPDATE series_facturacion
       SET ultimo_numero = NEW.numero,
           ultima_fecha_expedicion = NEW.fecha_expedicion
     WHERE id = s.id;

    RETURN NEW;
  END IF;

  -- 3) Factura ya emitida o anulada.
  IF OLD.estado = 'BORRADOR' THEN
    RAISE EXCEPTION 'VERIFACTU: un borrador solo puede pasar a EMITIDA'
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.estado = 'BORRADOR' OR (OLD.estado = 'ANULADA' AND NEW.estado <> 'ANULADA') THEN
    RAISE EXCEPTION 'VERIFACTU: transición de estado no permitida (% → %)', OLD.estado, NEW.estado
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- Comparación de la fila completa, quitando las columnas de gestión.
  -- Cualquier columna futura queda protegida por defecto.
  IF (to_jsonb(NEW) - mutables) IS DISTINCT FROM (to_jsonb(OLD) - mutables) THEN
    RAISE EXCEPTION 'VERIFACTU: la factura % está emitida y su contenido es inalterable; use una factura rectificativa',
      OLD.num_serie_factura
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER facturas_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facturas
  FOR EACH ROW EXECUTE FUNCTION vf_facturas_guard();
--> statement-breakpoint
CREATE TRIGGER facturas_no_truncate
  BEFORE TRUNCATE ON facturas
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- E. Ninguna factura emitida sin registro de alta, ni anulada sin registro
--    de anulación. Es un CONSTRAINT TRIGGER diferido: se evalúa en el COMMIT,
--    de modo que factura y registro tienen que confirmarse en la MISMA
--    transacción (art. 9-11 RD 1007/2023: generación simultánea).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_facturas_exigir_registro() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.estado = 'BORRADOR' AND NEW.estado = 'EMITIDA' AND NOT EXISTS (
       SELECT 1 FROM registros_verifactu r
        WHERE r.factura_id = NEW.id AND r.tipo_registro = 'ALTA') THEN
    RAISE EXCEPTION 'VERIFACTU: la factura % se ha emitido sin su registro de alta', NEW.num_serie_factura
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF OLD.estado = 'EMITIDA' AND NEW.estado = 'ANULADA' AND NOT EXISTS (
       SELECT 1 FROM registros_verifactu r
        WHERE r.factura_id = NEW.id AND r.tipo_registro = 'ANULACION') THEN
    RAISE EXCEPTION 'VERIFACTU: la factura % se ha anulado sin su registro de anulación', NEW.num_serie_factura
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER facturas_exigir_registro
  AFTER UPDATE OF estado ON facturas
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION vf_facturas_exigir_registro();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- B. Líneas, desglose y facturas relacionadas: solo se tocan en BORRADOR
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_detalle_factura_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_factura uuid;
  v_estado  estado_factura;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.factura_id <> OLD.factura_id OR NEW.empresa_id <> OLD.empresa_id) THEN
    RAISE EXCEPTION 'VERIFACTU: un detalle no puede moverse a otra factura'
      USING ERRCODE = 'restrict_violation';
  END IF;

  v_factura := CASE WHEN TG_OP = 'DELETE' THEN OLD.factura_id ELSE NEW.factura_id END;

  -- FOR SHARE: impide que la factura se emita mientras se edita su detalle.
  SELECT estado INTO v_estado FROM facturas WHERE id = v_factura FOR SHARE;

  IF NOT FOUND THEN
    -- Solo ocurre en el borrado en cascada de un BORRADOR (la cabecera ya
    -- pasó su propia guarda). En INSERT/UPDATE lo rechazará la clave foránea.
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  IF v_estado <> 'BORRADOR' THEN
    RAISE EXCEPTION 'VERIFACTU: la factura está emitida; su detalle ("%") es inalterable', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER facturas_lineas_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facturas_lineas
  FOR EACH ROW EXECUTE FUNCTION vf_detalle_factura_guard();
--> statement-breakpoint
CREATE TRIGGER facturas_desglose_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facturas_desglose
  FOR EACH ROW EXECUTE FUNCTION vf_detalle_factura_guard();
--> statement-breakpoint
CREATE TRIGGER facturas_relacionadas_guard
  BEFORE INSERT OR UPDATE OR DELETE ON facturas_relacionadas
  FOR EACH ROW EXECUTE FUNCTION vf_detalle_factura_guard();
--> statement-breakpoint
CREATE TRIGGER facturas_lineas_no_truncate
  BEFORE TRUNCATE ON facturas_lineas
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER facturas_desglose_no_truncate
  BEFORE TRUNCATE ON facturas_desglose
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER facturas_relacionadas_no_truncate
  BEFORE TRUNCATE ON facturas_relacionadas
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- D. ENCADENAMIENTO DE REGISTROS DE FACTURACIÓN
--
-- La huella SHA-256 la calcula la aplicación (módulo criptográfico). La base
-- de datos NO confía en ella a ciegas: antes de aceptar el registro comprueba,
-- con la cabecera de la cadena de ESA empresa bloqueada, que
--   · enlaza exactamente con el último registro de la empresa (id + huella),
--   · no retrocede en el tiempo (art. 7.i de la Orden HAC/1177/2024),
--   · sus datos coinciden con los de la factura a la que se refiere,
--   · se generó en el modo en que la empresa opera en ese momento.
-- Después asigna el número de secuencia y avanza la cabecera.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_registros_encadenar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c       cadenas_fiscales%ROWTYPE;
  f       facturas%ROWTYPE;
  v_modo  modo_verifactu;
BEGIN
  -- La fecha-hora "oficial" es el texto que entró en la huella; el timestamptz
  -- se deriva de él para que nunca puedan discrepar.
  NEW.generado_en := NEW.fecha_hora_huso_gen::timestamptz;

  -- Cerrojo de la cadena de ESTA empresa (y de ninguna otra).
  SELECT * INTO c
    FROM cadenas_fiscales
   WHERE empresa_id = NEW.empresa_id AND tipo_cadena = 'FACTURACION'
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFACTU: la empresa % no tiene cadena de facturación', NEW.empresa_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF c.ultimo_id IS NULL THEN
    -- Primer registro de la empresa.
    IF NOT NEW.es_primer_registro THEN
      RAISE EXCEPTION 'VERIFACTU: la cadena está vacía; el registro debe marcarse como primer registro'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF NEW.es_primer_registro
       OR NEW.registro_anterior_id IS DISTINCT FROM c.ultimo_id
       OR NEW.huella_anterior      IS DISTINCT FROM c.ultima_huella THEN
      RAISE EXCEPTION 'VERIFACTU: encadenamiento incorrecto; el registro no enlaza con el último de la cadena de su empresa (secuencia %)',
        c.ultimo_num_secuencia
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- Art. 7.i.2º: el último registro no puede ser más de un minuto posterior
    -- a la fecha-hora con la que se fecha el nuevo.
    IF c.ultima_generacion > NEW.generado_en + interval '1 minute' THEN
      RAISE EXCEPTION 'VERIFACTU: la fecha-hora de generación (%) es anterior a la del último registro de la cadena (%)',
        NEW.generado_en, c.ultima_generacion
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF NEW.generado_en > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'VERIFACTU: la fecha-hora de generación (%) es posterior a la hora actual del sistema', NEW.generado_en
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Coherencia con la factura (que es de la misma empresa por FK compuesta).
  SELECT * INTO f FROM facturas
   WHERE id = NEW.factura_id AND empresa_id = NEW.empresa_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFACTU: la factura no existe en esta empresa'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF NEW.id_emisor_factura IS DISTINCT FROM f.emisor_nif
     OR NEW.num_serie_factura IS DISTINCT FROM f.num_serie_factura
     OR NEW.fecha_expedicion  IS DISTINCT FROM f.fecha_expedicion THEN
    RAISE EXCEPTION 'VERIFACTU: la identificación del registro no coincide con la de la factura %', f.num_serie_factura
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF NEW.tipo_registro = 'ALTA' THEN
    IF f.estado <> 'EMITIDA' THEN
      RAISE EXCEPTION 'VERIFACTU: solo se genera registro de alta de una factura EMITIDA (estado actual: %)', f.estado
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.tipo_factura  IS DISTINCT FROM f.tipo_factura
       OR NEW.cuota_total   IS DISTINCT FROM f.cuota_total
       OR NEW.importe_total IS DISTINCT FROM f.importe_total THEN
      RAISE EXCEPTION 'VERIFACTU: tipo o importes del registro de alta no coinciden con la factura %', f.num_serie_factura
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF f.estado NOT IN ('EMITIDA', 'ANULADA') THEN
      RAISE EXCEPTION 'VERIFACTU: no se puede anular una factura que no ha sido emitida'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  -- El registro refleja el modo real de la empresa en este instante.
  SELECT modo_verifactu INTO v_modo FROM empresas WHERE id = NEW.empresa_id;
  IF NEW.modo IS DISTINCT FROM v_modo THEN
    RAISE EXCEPTION 'VERIFACTU: el registro se generó en modo % pero la empresa opera en modo %', NEW.modo, v_modo
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Todo correcto: se asigna la posición y avanza la cabecera.
  NEW.num_secuencia := c.ultimo_num_secuencia + 1;

  UPDATE cadenas_fiscales
     SET ultimo_id            = NEW.id,
         ultima_huella        = NEW.huella,
         ultimo_num_secuencia = NEW.num_secuencia,
         ultima_generacion    = NEW.generado_en
   WHERE empresa_id = NEW.empresa_id AND tipo_cadena = 'FACTURACION';

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER registros_encadenar
  BEFORE INSERT ON registros_verifactu
  FOR EACH ROW EXECUTE FUNCTION vf_registros_encadenar();
--> statement-breakpoint
CREATE TRIGGER registros_solo_insercion
  BEFORE UPDATE OR DELETE ON registros_verifactu
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER registros_no_truncate
  BEFORE TRUNCATE ON registros_verifactu
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- F. Cola de remisión: cada registro entra en la cola al nacer
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_registros_encolar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO envios_aeat (registro_id, empresa_id, num_secuencia, estado)
  VALUES (NEW.id, NEW.empresa_id, NEW.num_secuencia,
          CASE WHEN NEW.modo = 'VERIFACTU' THEN 'PENDIENTE'::estado_envio_aeat
               ELSE 'NO_APLICA'::estado_envio_aeat END);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER registros_encolar
  AFTER INSERT ON registros_verifactu
  FOR EACH ROW EXECUTE FUNCTION vf_registros_encolar();
--> statement-breakpoint

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

  -- Estados finales: la respuesta de la AEAT ya no se reescribe. Una
  -- corrección posterior es siempre un NUEVO registro (subsanación).
  IF OLD.estado IN ('NO_APLICA', 'ACEPTADO', 'ACEPTADO_CON_ERRORES', 'RECHAZADO')
     AND NEW.estado <> OLD.estado THEN
    RAISE EXCEPTION 'VERIFACTU: el envío está en estado final (%) y no admite cambios de estado', OLD.estado
      USING ERRCODE = 'restrict_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER envios_guard
  BEFORE INSERT OR UPDATE ON envios_aeat
  FOR EACH ROW EXECUTE FUNCTION vf_envios_guard();
--> statement-breakpoint
CREATE TRIGGER envios_no_delete
  BEFORE DELETE ON envios_aeat
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER envios_no_truncate
  BEFORE TRUNCATE ON envios_aeat
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint

-- -----------------------------------------------------------------------------
-- D'. ENCADENAMIENTO DEL REGISTRO DE EVENTOS (misma mecánica, cadena propia)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION vf_eventos_encadenar() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  c cadenas_fiscales%ROWTYPE;
BEGIN
  NEW.generado_en := NEW.fecha_hora_huso_gen::timestamptz;

  SELECT * INTO c
    FROM cadenas_fiscales
   WHERE empresa_id = NEW.empresa_id AND tipo_cadena = 'EVENTOS'
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'VERIFACTU: la empresa % no tiene cadena de eventos', NEW.empresa_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF c.ultimo_id IS NULL THEN
    IF NOT NEW.es_primer_evento THEN
      RAISE EXCEPTION 'VERIFACTU: la cadena de eventos está vacía; debe marcarse como primer evento'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSE
    IF NEW.es_primer_evento
       OR NEW.evento_anterior_id IS DISTINCT FROM c.ultimo_id
       OR NEW.huella_anterior    IS DISTINCT FROM c.ultima_huella THEN
      RAISE EXCEPTION 'VERIFACTU: encadenamiento de evento incorrecto; no enlaza con el último evento de su empresa (secuencia %)',
        c.ultimo_num_secuencia
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF c.ultima_generacion > NEW.generado_en + interval '1 minute' THEN
      RAISE EXCEPTION 'VERIFACTU: la fecha-hora del evento es anterior a la del último evento de la cadena'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;

  IF NEW.generado_en > now() + interval '1 minute' THEN
    RAISE EXCEPTION 'VERIFACTU: la fecha-hora del evento es posterior a la hora actual del sistema'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  NEW.num_secuencia := c.ultimo_num_secuencia + 1;

  UPDATE cadenas_fiscales
     SET ultimo_id            = NEW.id,
         ultima_huella        = NEW.huella,
         ultimo_num_secuencia = NEW.num_secuencia,
         ultima_generacion    = NEW.generado_en
   WHERE empresa_id = NEW.empresa_id AND tipo_cadena = 'EVENTOS';

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER eventos_encadenar
  BEFORE INSERT ON eventos_log
  FOR EACH ROW EXECUTE FUNCTION vf_eventos_encadenar();
--> statement-breakpoint
CREATE TRIGGER eventos_solo_insercion
  BEFORE UPDATE OR DELETE ON eventos_log
  FOR EACH ROW EXECUTE FUNCTION vf_prohibir_modificacion();
--> statement-breakpoint
CREATE TRIGGER eventos_no_truncate
  BEFORE TRUNCATE ON eventos_log
  FOR EACH STATEMENT EXECUTE FUNCTION vf_prohibir_modificacion();
