CREATE TYPE "public"."estado_cobro" AS ENUM('PENDIENTE', 'PARCIAL', 'COBRADA');--> statement-breakpoint
CREATE TYPE "public"."estado_envio_aeat" AS ENUM('NO_APLICA', 'PENDIENTE', 'ENVIANDO', 'ACEPTADO', 'ACEPTADO_CON_ERRORES', 'RECHAZADO', 'ERROR_TRANSITORIO');--> statement-breakpoint
CREATE TYPE "public"."estado_factura" AS ENUM('BORRADOR', 'EMITIDA', 'ANULADA');--> statement-breakpoint
CREATE TYPE "public"."modo_verifactu" AS ENUM('VERIFACTU', 'NO_VERIFACTU');--> statement-breakpoint
CREATE TYPE "public"."relacion_factura" AS ENUM('RECTIFICADA', 'SUSTITUIDA');--> statement-breakpoint
CREATE TYPE "public"."tipo_cadena" AS ENUM('FACTURACION', 'EVENTOS');--> statement-breakpoint
CREATE TYPE "public"."tipo_factura" AS ENUM('F1', 'F2', 'F3', 'R1', 'R2', 'R3', 'R4', 'R5');--> statement-breakpoint
CREATE TYPE "public"."tipo_rectificativa" AS ENUM('S', 'I');--> statement-breakpoint
CREATE TYPE "public"."tipo_registro" AS ENUM('ALTA', 'ANULACION');--> statement-breakpoint
CREATE TYPE "public"."tipo_serie" AS ENUM('ORDINARIA', 'SIMPLIFICADA', 'RECTIFICATIVA');--> statement-breakpoint
CREATE TABLE "cadenas_fiscales" (
	"empresa_id" uuid NOT NULL,
	"tipo_cadena" "tipo_cadena" NOT NULL,
	"ultimo_id" uuid,
	"ultima_huella" varchar(64),
	"ultimo_num_secuencia" bigint DEFAULT 0 NOT NULL,
	"ultima_generacion" timestamp with time zone,
	CONSTRAINT "cadenas_fiscales_pk" PRIMARY KEY("empresa_id","tipo_cadena")
);
--> statement-breakpoint
CREATE TABLE "clientes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"es_generico" boolean DEFAULT false NOT NULL,
	"nombre_razon" varchar(120) NOT NULL,
	"nif" varchar(9),
	"id_otro_codigo_pais" varchar(2),
	"id_otro_tipo" varchar(2),
	"id_otro_numero" varchar(20),
	"direccion" varchar(250),
	"codigo_postal" varchar(10),
	"municipio" varchar(100),
	"provincia" varchar(100),
	"codigo_pais" varchar(2) DEFAULT 'ES' NOT NULL,
	"email" varchar(255),
	"telefono" varchar(30),
	"recargo_equivalencia" boolean DEFAULT false NOT NULL,
	"notas" text,
	"archivado_en" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clientes_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "clientes_generico_sin_nif_ck" CHECK (NOT ("clientes"."es_generico" AND ("clientes"."nif" IS NOT NULL OR "clientes"."id_otro_numero" IS NOT NULL))),
	CONSTRAINT "clientes_id_otro_completo_ck" CHECK (("clientes"."id_otro_numero" IS NULL) = ("clientes"."id_otro_tipo" IS NULL)),
	CONSTRAINT "clientes_nif_formato_ck" CHECK ("clientes"."nif" IS NULL OR "clientes"."nif" ~ '^[A-Z0-9]{9}$')
);
--> statement-breakpoint
CREATE TABLE "empresas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" integer NOT NULL,
	"nif" varchar(9) NOT NULL,
	"nombre_razon" varchar(120) NOT NULL,
	"nombre_comercial" varchar(120),
	"direccion" varchar(250),
	"codigo_postal" varchar(10),
	"municipio" varchar(100),
	"provincia" varchar(100),
	"codigo_pais" varchar(2) DEFAULT 'ES' NOT NULL,
	"email" varchar(255),
	"telefono" varchar(30),
	"modo_verifactu" "modo_verifactu" DEFAULT 'VERIFACTU' NOT NULL,
	"modo_vigente_desde" timestamp with time zone DEFAULT now() NOT NULL,
	"numero_instalacion" varchar(100) NOT NULL,
	"huso_horario" varchar(40) DEFAULT 'Europe/Madrid' NOT NULL,
	"impuesto_por_defecto" varchar(2) DEFAULT '01' NOT NULL,
	"tipo_impositivo_por_defecto" numeric(5, 2) DEFAULT '21.00' NOT NULL,
	"retencion_irpf_por_defecto" numeric(5, 2),
	"activa" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "empresas_nif_uq" UNIQUE("nif"),
	CONSTRAINT "empresas_numero_instalacion_uq" UNIQUE("numero_instalacion"),
	CONSTRAINT "empresas_nif_formato_ck" CHECK ("empresas"."nif" ~ '^[A-Z0-9]{9}$'),
	CONSTRAINT "empresas_impuesto_ck" CHECK ("empresas"."impuesto_por_defecto" IN ('01','02','03','05'))
);
--> statement-breakpoint
CREATE TABLE "envios_aeat" (
	"registro_id" uuid PRIMARY KEY NOT NULL,
	"empresa_id" uuid NOT NULL,
	"num_secuencia" bigint NOT NULL,
	"estado" "estado_envio_aeat" NOT NULL,
	"intentos" integer DEFAULT 0 NOT NULL,
	"proximo_intento_en" timestamp with time zone DEFAULT now() NOT NULL,
	"lote_id" uuid,
	"enviado_en" timestamp with time zone,
	"respondido_en" timestamp with time zone,
	"csv" varchar(50),
	"codigo_error" varchar(10),
	"descripcion_error" text,
	"respuesta_aeat" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eventos_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"num_secuencia" bigint DEFAULT 0 NOT NULL,
	"tipo_evento" varchar(2) NOT NULL,
	"otros_datos" varchar(100),
	"detalle" jsonb,
	"usuario_id" integer,
	"ip_origen" varchar(45),
	"nif_obligado" varchar(9) NOT NULL,
	"sif_nif_productor" varchar(9) NOT NULL,
	"sif_id_sistema" varchar(2) NOT NULL,
	"sif_version" varchar(50) NOT NULL,
	"sif_numero_instalacion" varchar(100) NOT NULL,
	"fecha_hora_huso_gen" varchar(25) NOT NULL,
	"generado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"es_primer_evento" boolean DEFAULT false NOT NULL,
	"evento_anterior_id" uuid,
	"huella_anterior" varchar(64),
	"tipo_huella" varchar(2) DEFAULT '01' NOT NULL,
	"huella" varchar(64) NOT NULL,
	"xml_evento" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eventos_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "eventos_sin_bifurcacion_uq" UNIQUE("empresa_id","evento_anterior_id"),
	CONSTRAINT "eventos_secuencia_uq" UNIQUE("empresa_id","num_secuencia"),
	CONSTRAINT "eventos_tipo_ck" CHECK ("eventos_log"."tipo_evento" IN ('01','02','03','04','05','06','07','08','09','10','90')),
	CONSTRAINT "eventos_primer_evento_ck" CHECK (("eventos_log"."es_primer_evento" AND "eventos_log"."evento_anterior_id" IS NULL AND "eventos_log"."huella_anterior" IS NULL)
       OR (NOT "eventos_log"."es_primer_evento" AND "eventos_log"."evento_anterior_id" IS NOT NULL AND "eventos_log"."huella_anterior" IS NOT NULL)),
	CONSTRAINT "eventos_huella_formato_ck" CHECK ("eventos_log"."huella" ~ '^[0-9A-F]{64}$'),
	CONSTRAINT "eventos_fecha_hora_formato_ck" CHECK ("eventos_log"."fecha_hora_huso_gen" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$')
);
--> statement-breakpoint
CREATE TABLE "facturas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"serie_id" uuid NOT NULL,
	"numero" integer,
	"num_serie_factura" varchar(60),
	"tipo_factura" "tipo_factura" NOT NULL,
	"tipo_rectificativa" "tipo_rectificativa",
	"estado" "estado_factura" DEFAULT 'BORRADOR' NOT NULL,
	"estado_cobro" "estado_cobro" DEFAULT 'PENDIENTE' NOT NULL,
	"fecha_expedicion" date,
	"fecha_operacion" date,
	"emitida_en" timestamp with time zone,
	"anulada_en" timestamp with time zone,
	"cobrada_en" timestamp with time zone,
	"cliente_id" uuid,
	"destinatario_nombre" varchar(120),
	"destinatario_nif" varchar(9),
	"destinatario_id_otro_codigo_pais" varchar(2),
	"destinatario_id_otro_tipo" varchar(2),
	"destinatario_id_otro_numero" varchar(20),
	"destinatario_domicilio" varchar(400),
	"emisor_nif" varchar(9),
	"emisor_nombre_razon" varchar(120),
	"emisor_domicilio" varchar(400),
	"descripcion_operacion" varchar(500),
	"base_imponible_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"cuota_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"importe_total" numeric(12, 2) DEFAULT '0' NOT NULL,
	"retencion_irpf_porcentaje" numeric(5, 2),
	"retencion_irpf_importe" numeric(12, 2) DEFAULT '0' NOT NULL,
	"total_a_pagar" numeric(12, 2) DEFAULT '0' NOT NULL,
	"base_rectificada" numeric(12, 2),
	"cuota_rectificada" numeric(12, 2),
	"cuota_recargo_rectificado" numeric(12, 2),
	"observaciones" text,
	"creada_por" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facturas_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "facturas_serie_numero_uq" UNIQUE("empresa_id","serie_id","numero"),
	CONSTRAINT "facturas_num_serie_uq" UNIQUE("empresa_id","num_serie_factura"),
	CONSTRAINT "facturas_borrador_sin_numero_ck" CHECK ("facturas"."estado" <> 'BORRADOR' OR ("facturas"."numero" IS NULL AND "facturas"."num_serie_factura" IS NULL)),
	CONSTRAINT "facturas_emitida_completa_ck" CHECK ("facturas"."estado" = 'BORRADOR' OR (
            "facturas"."numero" IS NOT NULL AND "facturas"."numero" > 0
        AND "facturas"."num_serie_factura" IS NOT NULL
        AND "facturas"."fecha_expedicion" IS NOT NULL
        AND "facturas"."emitida_en" IS NOT NULL
        AND "facturas"."emisor_nif" IS NOT NULL
        AND "facturas"."emisor_nombre_razon" IS NOT NULL
        AND "facturas"."descripcion_operacion" IS NOT NULL)),
	CONSTRAINT "facturas_destinatario_ck" CHECK ("facturas"."estado" = 'BORRADOR' OR "facturas"."tipo_factura" IN ('F2','R5') OR (
            "facturas"."destinatario_nombre" IS NOT NULL
        AND ("facturas"."destinatario_nif" IS NOT NULL OR "facturas"."destinatario_id_otro_numero" IS NOT NULL))),
	CONSTRAINT "facturas_rectificativa_ck" CHECK (("facturas"."tipo_factura" IN ('R1','R2','R3','R4','R5')) = ("facturas"."tipo_rectificativa" IS NOT NULL)),
	CONSTRAINT "facturas_anulada_ck" CHECK (("facturas"."estado" = 'ANULADA') = ("facturas"."anulada_en" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "facturas_desglose" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"factura_id" uuid NOT NULL,
	"impuesto" varchar(2) DEFAULT '01' NOT NULL,
	"clave_regimen" varchar(2) DEFAULT '01' NOT NULL,
	"calificacion_operacion" varchar(2),
	"operacion_exenta" varchar(2),
	"tipo_impositivo" numeric(5, 2),
	"base_imponible" numeric(12, 2) NOT NULL,
	"cuota_repercutida" numeric(12, 2),
	"tipo_recargo_equivalencia" numeric(5, 2),
	"cuota_recargo_equivalencia" numeric(12, 2),
	CONSTRAINT "facturas_desglose_calificacion_ck" CHECK (("facturas_desglose"."calificacion_operacion" IS NOT NULL) <> ("facturas_desglose"."operacion_exenta" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "facturas_lineas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"factura_id" uuid NOT NULL,
	"orden" smallint NOT NULL,
	"descripcion" varchar(500) NOT NULL,
	"cantidad" numeric(12, 3) DEFAULT '1' NOT NULL,
	"precio_unitario" numeric(14, 4) NOT NULL,
	"descuento_porcentaje" numeric(5, 2) DEFAULT '0' NOT NULL,
	"base_linea" numeric(12, 2) NOT NULL,
	"impuesto" varchar(2) DEFAULT '01' NOT NULL,
	"clave_regimen" varchar(2) DEFAULT '01' NOT NULL,
	"calificacion_operacion" varchar(2),
	"operacion_exenta" varchar(2),
	"tipo_impositivo" numeric(5, 2),
	"cuota" numeric(12, 2) DEFAULT '0' NOT NULL,
	"tipo_recargo_equivalencia" numeric(5, 2),
	"cuota_recargo_equivalencia" numeric(12, 2) DEFAULT '0' NOT NULL,
	CONSTRAINT "facturas_lineas_orden_uq" UNIQUE("factura_id","orden"),
	CONSTRAINT "facturas_lineas_calificacion_ck" CHECK (("facturas_lineas"."calificacion_operacion" IS NOT NULL) <> ("facturas_lineas"."operacion_exenta" IS NOT NULL)),
	CONSTRAINT "facturas_lineas_calificacion_valor_ck" CHECK ("facturas_lineas"."calificacion_operacion" IS NULL OR "facturas_lineas"."calificacion_operacion" IN ('S1','S2','N1','N2')),
	CONSTRAINT "facturas_lineas_exenta_valor_ck" CHECK ("facturas_lineas"."operacion_exenta" IS NULL OR "facturas_lineas"."operacion_exenta" IN ('E1','E2','E3','E4','E5','E6')),
	CONSTRAINT "facturas_lineas_impuesto_ck" CHECK ("facturas_lineas"."impuesto" IN ('01','02','03','05'))
);
--> statement-breakpoint
CREATE TABLE "facturas_relacionadas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"factura_id" uuid NOT NULL,
	"relacion" "relacion_factura" NOT NULL,
	"factura_referida_id" uuid,
	"referida_emisor_nif" varchar(9) NOT NULL,
	"referida_num_serie" varchar(60) NOT NULL,
	"referida_fecha_expedicion" date NOT NULL,
	CONSTRAINT "facturas_relacionadas_uq" UNIQUE("factura_id","referida_num_serie")
);
--> statement-breakpoint
CREATE TABLE "registros_verifactu" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"factura_id" uuid NOT NULL,
	"num_secuencia" bigint DEFAULT 0 NOT NULL,
	"tipo_registro" "tipo_registro" NOT NULL,
	"es_subsanacion" boolean DEFAULT false NOT NULL,
	"rechazo_previo" varchar(1) DEFAULT 'N' NOT NULL,
	"id_emisor_factura" varchar(9) NOT NULL,
	"nombre_razon_emisor" varchar(120) NOT NULL,
	"num_serie_factura" varchar(60) NOT NULL,
	"fecha_expedicion" date NOT NULL,
	"tipo_factura" "tipo_factura",
	"cuota_total" numeric(12, 2),
	"importe_total" numeric(12, 2),
	"fecha_hora_huso_gen" varchar(25) NOT NULL,
	"generado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"es_primer_registro" boolean DEFAULT false NOT NULL,
	"registro_anterior_id" uuid,
	"huella_anterior" varchar(64),
	"tipo_huella" varchar(2) DEFAULT '01' NOT NULL,
	"huella" varchar(64) NOT NULL,
	"modo" "modo_verifactu" NOT NULL,
	"sif_id_sistema" varchar(2) NOT NULL,
	"sif_version" varchar(50) NOT NULL,
	"sif_numero_instalacion" varchar(100) NOT NULL,
	"xml_registro" text NOT NULL,
	"xml_firmado" boolean DEFAULT false NOT NULL,
	"qr_url" text,
	"creado_por" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registros_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "registros_sin_bifurcacion_uq" UNIQUE("empresa_id","registro_anterior_id"),
	CONSTRAINT "registros_secuencia_uq" UNIQUE("empresa_id","num_secuencia"),
	CONSTRAINT "registros_huella_uq" UNIQUE("empresa_id","huella"),
	CONSTRAINT "registros_primer_registro_ck" CHECK (("registros_verifactu"."es_primer_registro" AND "registros_verifactu"."registro_anterior_id" IS NULL AND "registros_verifactu"."huella_anterior" IS NULL)
       OR (NOT "registros_verifactu"."es_primer_registro" AND "registros_verifactu"."registro_anterior_id" IS NOT NULL AND "registros_verifactu"."huella_anterior" IS NOT NULL)),
	CONSTRAINT "registros_huella_formato_ck" CHECK ("registros_verifactu"."huella" ~ '^[0-9A-F]{64}$'),
	CONSTRAINT "registros_huella_anterior_formato_ck" CHECK ("registros_verifactu"."huella_anterior" IS NULL OR "registros_verifactu"."huella_anterior" ~ '^[0-9A-F]{64}$'),
	CONSTRAINT "registros_fecha_hora_formato_ck" CHECK ("registros_verifactu"."fecha_hora_huso_gen" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$'),
	CONSTRAINT "registros_rechazo_previo_ck" CHECK ("registros_verifactu"."rechazo_previo" IN ('N','S','X')),
	CONSTRAINT "registros_alta_completa_ck" CHECK ("registros_verifactu"."tipo_registro" <> 'ALTA' OR (
            "registros_verifactu"."tipo_factura" IS NOT NULL AND "registros_verifactu"."cuota_total" IS NOT NULL
        AND "registros_verifactu"."importe_total" IS NOT NULL AND "registros_verifactu"."qr_url" IS NOT NULL)),
	CONSTRAINT "registros_anulacion_ck" CHECK ("registros_verifactu"."tipo_registro" <> 'ANULACION' OR NOT "registros_verifactu"."es_subsanacion"),
	CONSTRAINT "registros_firma_ck" CHECK ("registros_verifactu"."modo" = 'VERIFACTU' OR "registros_verifactu"."xml_firmado")
);
--> statement-breakpoint
CREATE TABLE "series_facturacion" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"codigo" varchar(20) NOT NULL,
	"descripcion" varchar(100),
	"tipo_serie" "tipo_serie" NOT NULL,
	"ejercicio" smallint,
	"digitos_relleno" smallint DEFAULT 6 NOT NULL,
	"ultimo_numero" integer DEFAULT 0 NOT NULL,
	"ultima_fecha_expedicion" date,
	"por_defecto" boolean DEFAULT false NOT NULL,
	"activa" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "series_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "series_empresa_codigo_uq" UNIQUE("empresa_id","codigo"),
	CONSTRAINT "series_ultimo_numero_ck" CHECK ("series_facturacion"."ultimo_numero" >= 0),
	CONSTRAINT "series_digitos_ck" CHECK ("series_facturacion"."digitos_relleno" BETWEEN 1 AND 12),
	CONSTRAINT "series_codigo_formato_ck" CHECK ("series_facturacion"."codigo" ~ '^[A-Za-z0-9/_.-]*$')
);
--> statement-breakpoint
ALTER TABLE "cadenas_fiscales" ADD CONSTRAINT "cadenas_fiscales_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clientes" ADD CONSTRAINT "clientes_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "empresas" ADD CONSTRAINT "empresas_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "envios_aeat" ADD CONSTRAINT "envios_aeat_registro_fk" FOREIGN KEY ("empresa_id","registro_id") REFERENCES "public"."registros_verifactu"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_log" ADD CONSTRAINT "eventos_log_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_log" ADD CONSTRAINT "eventos_log_usuario_id_users_id_fk" FOREIGN KEY ("usuario_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eventos_log" ADD CONSTRAINT "eventos_anterior_fk" FOREIGN KEY ("empresa_id","evento_anterior_id") REFERENCES "public"."eventos_log"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_creada_por_users_id_fk" FOREIGN KEY ("creada_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_serie_fk" FOREIGN KEY ("empresa_id","serie_id") REFERENCES "public"."series_facturacion"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas" ADD CONSTRAINT "facturas_cliente_fk" FOREIGN KEY ("empresa_id","cliente_id") REFERENCES "public"."clientes"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas_desglose" ADD CONSTRAINT "facturas_desglose_factura_fk" FOREIGN KEY ("empresa_id","factura_id") REFERENCES "public"."facturas"("empresa_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas_lineas" ADD CONSTRAINT "facturas_lineas_factura_fk" FOREIGN KEY ("empresa_id","factura_id") REFERENCES "public"."facturas"("empresa_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas_relacionadas" ADD CONSTRAINT "facturas_relacionadas_factura_fk" FOREIGN KEY ("empresa_id","factura_id") REFERENCES "public"."facturas"("empresa_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facturas_relacionadas" ADD CONSTRAINT "facturas_relacionadas_referida_fk" FOREIGN KEY ("empresa_id","factura_referida_id") REFERENCES "public"."facturas"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registros_verifactu" ADD CONSTRAINT "registros_verifactu_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registros_verifactu" ADD CONSTRAINT "registros_verifactu_creado_por_users_id_fk" FOREIGN KEY ("creado_por") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registros_verifactu" ADD CONSTRAINT "registros_factura_fk" FOREIGN KEY ("empresa_id","factura_id") REFERENCES "public"."facturas"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registros_verifactu" ADD CONSTRAINT "registros_anterior_fk" FOREIGN KEY ("empresa_id","registro_anterior_id") REFERENCES "public"."registros_verifactu"("empresa_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "series_facturacion" ADD CONSTRAINT "series_facturacion_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "clientes_empresa_nif_uq" ON "clientes" USING btree ("empresa_id","nif") WHERE "clientes"."nif" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "clientes_un_generico_uq" ON "clientes" USING btree ("empresa_id") WHERE "clientes"."es_generico";--> statement-breakpoint
CREATE INDEX "clientes_empresa_nombre_idx" ON "clientes" USING btree ("empresa_id","nombre_razon");--> statement-breakpoint
CREATE INDEX "empresas_team_idx" ON "empresas" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "envios_aeat_cola_idx" ON "envios_aeat" USING btree ("proximo_intento_en","empresa_id","num_secuencia") WHERE "envios_aeat"."estado" IN ('PENDIENTE','ERROR_TRANSITORIO');--> statement-breakpoint
CREATE INDEX "envios_aeat_empresa_estado_idx" ON "envios_aeat" USING btree ("empresa_id","estado");--> statement-breakpoint
CREATE INDEX "envios_aeat_lote_idx" ON "envios_aeat" USING btree ("lote_id");--> statement-breakpoint
CREATE UNIQUE INDEX "eventos_un_primero_uq" ON "eventos_log" USING btree ("empresa_id") WHERE "eventos_log"."evento_anterior_id" IS NULL;--> statement-breakpoint
CREATE INDEX "eventos_empresa_tipo_idx" ON "eventos_log" USING btree ("empresa_id","tipo_evento","generado_en");--> statement-breakpoint
CREATE INDEX "facturas_empresa_fecha_idx" ON "facturas" USING btree ("empresa_id","fecha_expedicion");--> statement-breakpoint
CREATE INDEX "facturas_empresa_estado_idx" ON "facturas" USING btree ("empresa_id","estado");--> statement-breakpoint
CREATE INDEX "facturas_empresa_cliente_idx" ON "facturas" USING btree ("empresa_id","cliente_id");--> statement-breakpoint
CREATE INDEX "facturas_cobro_pendiente_idx" ON "facturas" USING btree ("empresa_id","fecha_expedicion") WHERE "facturas"."estado" = 'EMITIDA' AND "facturas"."estado_cobro" <> 'COBRADA';--> statement-breakpoint
CREATE INDEX "facturas_desglose_factura_idx" ON "facturas_desglose" USING btree ("factura_id");--> statement-breakpoint
CREATE INDEX "facturas_relacionadas_referida_idx" ON "facturas_relacionadas" USING btree ("factura_referida_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registros_un_primero_uq" ON "registros_verifactu" USING btree ("empresa_id") WHERE "registros_verifactu"."registro_anterior_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "registros_un_alta_inicial_uq" ON "registros_verifactu" USING btree ("factura_id") WHERE "registros_verifactu"."tipo_registro" = 'ALTA' AND NOT "registros_verifactu"."es_subsanacion";--> statement-breakpoint
CREATE INDEX "registros_factura_idx" ON "registros_verifactu" USING btree ("empresa_id","factura_id");--> statement-breakpoint
CREATE UNIQUE INDEX "series_por_defecto_uq" ON "series_facturacion" USING btree ("empresa_id","tipo_serie") WHERE "series_facturacion"."por_defecto";