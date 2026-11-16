CREATE TYPE "public"."resultado_lote_aeat" AS ENUM('EN_CURSO', 'CORRECTO', 'PARCIALMENTE_CORRECTO', 'INCORRECTO', 'RECHAZADO', 'ERROR_TRANSITORIO');--> statement-breakpoint
CREATE TYPE "public"."tipo_remision_aeat" AS ENUM('VOLUNTARIA', 'REQUERIMIENTO');--> statement-breakpoint
CREATE TABLE "aeat_control_flujo" (
	"empresa_id" uuid PRIMARY KEY NOT NULL,
	"tiempo_espera_seg" integer DEFAULT 60 NOT NULL,
	"ultimo_envio_en" timestamp with time zone,
	"proximo_envio_en" timestamp with time zone DEFAULT now() NOT NULL,
	"fallos_consecutivos" integer DEFAULT 0 NOT NULL,
	"incidencia_desde" timestamp with time zone,
	"ultimo_error_codigo" varchar(20),
	"ultimo_error" text,
	"requiere_intervencion" boolean DEFAULT false NOT NULL,
	"lote_en_curso_id" uuid,
	"lote_en_curso_caduca_en" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "aeat_control_flujo_espera_ck" CHECK ("aeat_control_flujo"."tiempo_espera_seg" BETWEEN 0 AND 9999),
	CONSTRAINT "aeat_control_flujo_fallos_ck" CHECK ("aeat_control_flujo"."fallos_consecutivos" >= 0),
	CONSTRAINT "aeat_control_flujo_arrendamiento_ck" CHECK (("aeat_control_flujo"."lote_en_curso_id" IS NULL) = ("aeat_control_flujo"."lote_en_curso_caduca_en" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "aeat_lotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"empresa_id" uuid NOT NULL,
	"tipo_remision" "tipo_remision_aeat" DEFAULT 'VOLUNTARIA' NOT NULL,
	"entorno" varchar(10) NOT NULL,
	"endpoint" text NOT NULL,
	"ref_requerimiento" varchar(18),
	"incidencia" boolean DEFAULT false NOT NULL,
	"num_registros" integer NOT NULL,
	"primer_num_secuencia" bigint NOT NULL,
	"ultimo_num_secuencia" bigint NOT NULL,
	"peticion_sha256" varchar(64) NOT NULL,
	"resultado" "resultado_lote_aeat" DEFAULT 'EN_CURSO' NOT NULL,
	"estado_http" integer,
	"csv" varchar(50),
	"tiempo_espera_seg" integer,
	"codigo_error" varchar(20),
	"descripcion_error" text,
	"respuesta_xml" text,
	"resultado_registros" jsonb,
	"iniciado_en" timestamp with time zone DEFAULT now() NOT NULL,
	"finalizado_en" timestamp with time zone,
	CONSTRAINT "aeat_lotes_empresa_id_uq" UNIQUE("empresa_id","id"),
	CONSTRAINT "aeat_lotes_num_registros_ck" CHECK ("aeat_lotes"."num_registros" BETWEEN 1 AND 1000),
	CONSTRAINT "aeat_lotes_entorno_ck" CHECK ("aeat_lotes"."entorno" IN ('pruebas','produccion')),
	CONSTRAINT "aeat_lotes_requerimiento_ck" CHECK (("aeat_lotes"."tipo_remision" = 'REQUERIMIENTO') = ("aeat_lotes"."ref_requerimiento" IS NOT NULL)),
	CONSTRAINT "aeat_lotes_cierre_ck" CHECK (("aeat_lotes"."resultado" = 'EN_CURSO') = ("aeat_lotes"."finalizado_en" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "envios_aeat" ADD COLUMN "entrega_incierta" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "aeat_control_flujo" ADD CONSTRAINT "aeat_control_flujo_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aeat_lotes" ADD CONSTRAINT "aeat_lotes_empresa_id_empresas_id_fk" FOREIGN KEY ("empresa_id") REFERENCES "public"."empresas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aeat_control_flujo_proximo_idx" ON "aeat_control_flujo" USING btree ("proximo_envio_en");--> statement-breakpoint
CREATE INDEX "aeat_lotes_empresa_idx" ON "aeat_lotes" USING btree ("empresa_id","iniciado_en");