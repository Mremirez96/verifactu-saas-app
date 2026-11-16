/**
 * lib/db/schema.ts — Modelo de datos VERI*FACTU (Fase 1)
 *
 * Base normativa: RD 1007/2023 (RRSIF) y Orden HAC/1177/2024.
 *
 * ARQUITECTURA MULTI-TENANT
 *   teams (cuenta SaaS / suscripción Stripe, ya existente)
 *     └─ empresas (obligado tributario = emisor; unidad de aislamiento fiscal)
 *          ├─ clientes
 *          ├─ series_facturacion
 *          ├─ facturas ─ facturas_lineas / facturas_desglose / facturas_relacionadas
 *          ├─ registros_verifactu ─ envios_aeat        (cadena de registros de facturación)
 *          ├─ eventos_log                              (cadena de registros de evento)
 *          └─ cadenas_fiscales                         (cabecera de cada cadena)
 *
 * REGLA DE AISLAMIENTO: toda tabla fiscal lleva `empresa_id` y toda relación
 * entre tablas fiscales es una clave foránea COMPUESTA (empresa_id, <id>).
 * Así es la propia base de datos, y no solo el código, la que impide que una
 * fila de una empresa apunte a una fila de otra.
 *
 * Lo que Drizzle no sabe expresar vive en dos migraciones SQL escritas a mano,
 * que son parte inseparable de este esquema:
 *   · `0002_verifactu_guardas.sql`     → triggers de inalterabilidad, numeración
 *                                        sin saltos y validación del encadenamiento.
 *   · `0003_verifactu_privilegios.sql` → rol de aplicación con privilegios
 *                                        acotados (ver lib/db/README.md).
 */
import {
  pgTable,
  pgEnum,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  smallint,
  bigint,
  uuid,
  boolean,
  numeric,
  date,
  jsonb,
  index,
  uniqueIndex,
  unique,
  primaryKey,
  foreignKey,
  check,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/* ========================================================================== */
/*  1. TABLAS EXISTENTES DEL STARTER (sin cambios de estructura)              */
/* ========================================================================== */

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: varchar('role', { length: 20 }).notNull().default('member'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  deletedAt: timestamp('deleted_at'),
});

/** Cuenta SaaS (tenant comercial). Una cuenta puede gestionar varias empresas. */
export const teams = pgTable('teams', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
  stripeCustomerId: text('stripe_customer_id').unique(),
  stripeSubscriptionId: text('stripe_subscription_id').unique(),
  stripeProductId: text('stripe_product_id'),
  planName: varchar('plan_name', { length: 50 }),
  subscriptionStatus: varchar('subscription_status', { length: 20 }),
});

export const teamMembers = pgTable('team_members', {
  id: serial('id').primaryKey(),
  userId: integer('user_id')
    .notNull()
    .references(() => users.id),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  role: varchar('role', { length: 50 }).notNull(),
  joinedAt: timestamp('joined_at').notNull().defaultNow(),
});

/**
 * Actividad de la aplicación (login, invitaciones...). NO es el registro de
 * eventos del RRSIF: ese es `eventos_log`, encadenado e inalterable.
 */
export const activityLogs = pgTable('activity_logs', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  userId: integer('user_id').references(() => users.id),
  action: text('action').notNull(),
  timestamp: timestamp('timestamp').notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
});

export const invitations = pgTable('invitations', {
  id: serial('id').primaryKey(),
  teamId: integer('team_id')
    .notNull()
    .references(() => teams.id),
  email: varchar('email', { length: 255 }).notNull(),
  role: varchar('role', { length: 50 }).notNull(),
  invitedBy: integer('invited_by')
    .notNull()
    .references(() => users.id),
  invitedAt: timestamp('invited_at').notNull().defaultNow(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
});

/* ========================================================================== */
/*  2. ENUMERADOS FISCALES                                                    */
/* ========================================================================== */

/** Modo de funcionamiento del SIF para una empresa (art. 15-16 RD 1007/2023). */
export const modoVerifactuEnum = pgEnum('modo_verifactu', [
  'VERIFACTU', // remisión automática a la AEAT; basta la huella
  'NO_VERIFACTU', // conservación local; exige firma XAdES y registro de eventos
]);

/** Lista L2 del anexo de la Orden HAC/1177/2024. */
export const tipoFacturaEnum = pgEnum('tipo_factura', [
  'F1', // Factura completa
  'F2', // Factura simplificada / sin identificación del destinatario
  'F3', // Factura en sustitución de simplificadas
  'R1', // Rectificativa: error fundado en derecho y art. 80 Uno, Dos y Seis LIVA
  'R2', // Rectificativa: art. 80.3 (concurso)
  'R3', // Rectificativa: art. 80.4 (incobrable)
  'R4', // Rectificativa: resto
  'R5', // Rectificativa de facturas simplificadas
]);

/** Lista L3: S = por sustitución, I = por diferencias. */
export const tipoRectificativaEnum = pgEnum('tipo_rectificativa', ['S', 'I']);

/** Ciclo de vida fiscal. No hay vuelta atrás: BORRADOR → EMITIDA → ANULADA. */
export const estadoFacturaEnum = pgEnum('estado_factura', [
  'BORRADOR', // editable y borrable; todavía no existe fiscalmente
  'EMITIDA', // inalterable; tiene número y registro de alta
  'ANULADA', // inalterable; tiene además registro de anulación
]);

/** Estado de cobro: dato de gestión, independiente del estado fiscal. */
export const estadoCobroEnum = pgEnum('estado_cobro', [
  'PENDIENTE',
  'PARCIAL',
  'COBRADA',
]);

export const tipoSerieEnum = pgEnum('tipo_serie', [
  'ORDINARIA',
  'SIMPLIFICADA',
  'RECTIFICATIVA', // las rectificativas exigen serie específica (art. 6.1.a RD 1619/2012)
]);

export const tipoRegistroEnum = pgEnum('tipo_registro', ['ALTA', 'ANULACION']);

export const tipoCadenaEnum = pgEnum('tipo_cadena', ['FACTURACION', 'EVENTOS']);

export const relacionFacturaEnum = pgEnum('relacion_factura', [
  'RECTIFICADA', // factura corregida por una R1-R5
  'SUSTITUIDA', // simplificada sustituida por una F3
]);

/** Cola de remisión a la AEAT. */
export const estadoEnvioEnum = pgEnum('estado_envio_aeat', [
  'NO_APLICA', // registro generado en modo NO VERI*FACTU
  'PENDIENTE', // en cola, aún no enviado
  'ENVIANDO', // tomado por un worker
  'ACEPTADO', // "Correcto"
  'ACEPTADO_CON_ERRORES', // admitido; requiere registro de subsanación
  'RECHAZADO', // "Incorrecto"; requiere nuevo registro con RechazoPrevio
  'ERROR_TRANSITORIO', // fallo técnico (red, 5xx, timeout): se reintenta
]);

/* ========================================================================== */
/*  3. EMPRESAS / EMISORES                                                    */
/* ========================================================================== */

export const empresas = pgTable(
  'empresas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    teamId: integer('team_id')
      .notNull()
      .references(() => teams.id),

    // --- Datos fiscales del obligado a expedir factura ---
    nif: varchar('nif', { length: 9 }).notNull(),
    nombreRazon: varchar('nombre_razon', { length: 120 }).notNull(),
    nombreComercial: varchar('nombre_comercial', { length: 120 }),
    direccion: varchar('direccion', { length: 250 }),
    codigoPostal: varchar('codigo_postal', { length: 10 }),
    municipio: varchar('municipio', { length: 100 }),
    provincia: varchar('provincia', { length: 100 }),
    codigoPais: varchar('codigo_pais', { length: 2 }).notNull().default('ES'),
    email: varchar('email', { length: 255 }),
    telefono: varchar('telefono', { length: 30 }),

    // --- Configuración VERI*FACTU ---
    modoVerifactu: modoVerifactuEnum('modo_verifactu')
      .notNull()
      .default('VERIFACTU'),
    /** Desde cuándo rige el modo actual. La opción VERI*FACTU vincula hasta fin de año natural. */
    modoVigenteDesde: timestamp('modo_vigente_desde', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /**
     * «NumeroInstalacion» del bloque SistemaInformatico: identifica esta
     * instalación lógica del SIF para este obligado. Entra en la huella de
     * los registros de evento. Inmutable una vez creada la empresa.
     */
    numeroInstalacion: varchar('numero_instalacion', { length: 100 }).notNull(),
    /** Huso con el que se fechan los registros (p. ej. Atlantic/Canary). */
    husoHorario: varchar('huso_horario', { length: 40 })
      .notNull()
      .default('Europe/Madrid'),

    // --- Valores por defecto para agilizar la emisión ---
    /** Lista L1: 01 IVA, 02 IPSI (Ceuta/Melilla), 03 IGIC (Canarias), 05 Otros. */
    impuestoPorDefecto: varchar('impuesto_por_defecto', { length: 2 })
      .notNull()
      .default('01'),
    tipoImpositivoPorDefecto: numeric('tipo_impositivo_por_defecto', {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default('21.00'),
    /** % de retención IRPF habitual (profesionales). NULL = no aplica. */
    retencionIrpfPorDefecto: numeric('retencion_irpf_por_defecto', {
      precision: 5,
      scale: 2,
    }),

    activa: boolean('activa').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Un NIF = una empresa = una única cadena por obligado (art. 7.c Orden).
    unique('empresas_nif_uq').on(t.nif),
    unique('empresas_numero_instalacion_uq').on(t.numeroInstalacion),
    index('empresas_team_idx').on(t.teamId),
    check('empresas_nif_formato_ck', sql`${t.nif} ~ '^[A-Z0-9]{9}$'`),
    check(
      'empresas_impuesto_ck',
      sql`${t.impuestoPorDefecto} IN ('01','02','03','05')`
    ),
  ]
);

/* ========================================================================== */
/*  4. CLIENTES                                                               */
/* ========================================================================== */

export const clientes = pgTable(
  'clientes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),

    /**
     * TRUE = cliente comodín ("Clientes varios / venta de mostrador") para
     * tickets sin destinatario. Solo puede haber uno por empresa.
     */
    esGenerico: boolean('es_generico').notNull().default(false),
    nombreRazon: varchar('nombre_razon', { length: 120 }).notNull(),

    // Identificación fiscal. El NIF es opcional: una peluquería o una clínica
    // guardan clientes particulares sin NIF. Lo que SÍ lo exige es emitir una
    // factura completa (ver check en `facturas`).
    nif: varchar('nif', { length: 9 }),
    // Bloque «IDOtro» para destinatarios sin NIF español (lista L7).
    idOtroCodigoPais: varchar('id_otro_codigo_pais', { length: 2 }),
    idOtroTipo: varchar('id_otro_tipo', { length: 2 }),
    idOtroNumero: varchar('id_otro_numero', { length: 20 }),

    direccion: varchar('direccion', { length: 250 }),
    codigoPostal: varchar('codigo_postal', { length: 10 }),
    municipio: varchar('municipio', { length: 100 }),
    provincia: varchar('provincia', { length: 100 }),
    codigoPais: varchar('codigo_pais', { length: 2 }).notNull().default('ES'),
    email: varchar('email', { length: 255 }),
    telefono: varchar('telefono', { length: 30 }),

    /** Minorista en recargo de equivalencia: se le repercute el recargo. */
    recargoEquivalencia: boolean('recargo_equivalencia')
      .notNull()
      .default(false),
    notas: text('notas'),

    /** Baja lógica. Un cliente con facturas nunca se borra físicamente (FK). */
    archivadoEn: timestamp('archivado_en', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Diana de las FK compuestas: garantiza que (empresa, cliente) van juntos.
    unique('clientes_empresa_id_uq').on(t.empresaId, t.id),
    uniqueIndex('clientes_empresa_nif_uq')
      .on(t.empresaId, t.nif)
      .where(sql`${t.nif} IS NOT NULL`),
    uniqueIndex('clientes_un_generico_uq')
      .on(t.empresaId)
      .where(sql`${t.esGenerico}`),
    index('clientes_empresa_nombre_idx').on(t.empresaId, t.nombreRazon),
    check(
      'clientes_generico_sin_nif_ck',
      sql`NOT (${t.esGenerico} AND (${t.nif} IS NOT NULL OR ${t.idOtroNumero} IS NOT NULL))`
    ),
    check(
      'clientes_id_otro_completo_ck',
      sql`(${t.idOtroNumero} IS NULL) = (${t.idOtroTipo} IS NULL)`
    ),
    check(
      'clientes_nif_formato_ck',
      sql`${t.nif} IS NULL OR ${t.nif} ~ '^[A-Z0-9]{9}$'`
    ),
  ]
);

/* ========================================================================== */
/*  5. SERIES DE FACTURACIÓN                                                  */
/* ========================================================================== */

/**
 * Cada serie guarda su propio contador. El contador NO lo toca la aplicación:
 * lo avanza el trigger de emisión de `facturas`, dentro de la misma
 * transacción y con la fila bloqueada (SELECT ... FOR UPDATE). Al ser una fila
 * y no una SEQUENCE, si la transacción aborta el número se devuelve y no
 * quedan huecos.
 */
export const seriesFacturacion = pgTable(
  'series_facturacion',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),

    /** Prefijo que antecede al número, p. ej. "F26-" → "F26-000001". */
    codigo: varchar('codigo', { length: 20 }).notNull(),
    descripcion: varchar('descripcion', { length: 100 }),
    tipoSerie: tipoSerieEnum('tipo_serie').notNull(),
    /** Informativo. El reinicio anual se hace creando una serie nueva. */
    ejercicio: smallint('ejercicio'),
    digitosRelleno: smallint('digitos_relleno').notNull().default(6),

    ultimoNumero: integer('ultimo_numero').notNull().default(0),
    ultimaFechaExpedicion: date('ultima_fecha_expedicion'),

    porDefecto: boolean('por_defecto').notNull().default(false),
    activa: boolean('activa').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('series_empresa_id_uq').on(t.empresaId, t.id),
    unique('series_empresa_codigo_uq').on(t.empresaId, t.codigo),
    // Como mucho una serie por defecto por empresa y tipo.
    uniqueIndex('series_por_defecto_uq')
      .on(t.empresaId, t.tipoSerie)
      .where(sql`${t.porDefecto}`),
    check('series_ultimo_numero_ck', sql`${t.ultimoNumero} >= 0`),
    check('series_digitos_ck', sql`${t.digitosRelleno} BETWEEN 1 AND 12`),
    // Subconjunto seguro de los caracteres que admite NumSerieFactura.
    check('series_codigo_formato_ck', sql`${t.codigo} ~ '^[A-Za-z0-9/_.-]*$'`),
  ]
);

/* ========================================================================== */
/*  6. FACTURAS (cabecera)                                                    */
/* ========================================================================== */

export const facturas = pgTable(
  'facturas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),
    serieId: uuid('serie_id').notNull(),

    // --- Numeración: la asigna la base de datos al emitir, nunca la app ---
    numero: integer('numero'),
    /** «NumSerieFactura» = código de serie + número. Máx. 60 caracteres. */
    numSerieFactura: varchar('num_serie_factura', { length: 60 }),

    tipoFactura: tipoFacturaEnum('tipo_factura').notNull(),
    tipoRectificativa: tipoRectificativaEnum('tipo_rectificativa'),
    estado: estadoFacturaEnum('estado').notNull().default('BORRADOR'),
    estadoCobro: estadoCobroEnum('estado_cobro').notNull().default('PENDIENTE'),

    fechaExpedicion: date('fecha_expedicion'),
    /** Solo si difiere de la fecha de expedición. */
    fechaOperacion: date('fecha_operacion'),
    emitidaEn: timestamp('emitida_en', { withTimezone: true }),
    anuladaEn: timestamp('anulada_en', { withTimezone: true }),
    cobradaEn: timestamp('cobrada_en', { withTimezone: true }),

    // --- Destinatario: enlace + FOTO FIJA en el momento de emitir ---
    // La ficha del cliente puede cambiar después; la factura emitida, no.
    clienteId: uuid('cliente_id'),
    destinatarioNombre: varchar('destinatario_nombre', { length: 120 }),
    destinatarioNif: varchar('destinatario_nif', { length: 9 }),
    destinatarioIdOtroCodigoPais: varchar('destinatario_id_otro_codigo_pais', {
      length: 2,
    }),
    destinatarioIdOtroTipo: varchar('destinatario_id_otro_tipo', { length: 2 }),
    destinatarioIdOtroNumero: varchar('destinatario_id_otro_numero', {
      length: 20,
    }),
    destinatarioDomicilio: varchar('destinatario_domicilio', { length: 400 }),

    // --- Emisor: foto fija en el momento de emitir ---
    emisorNif: varchar('emisor_nif', { length: 9 }),
    emisorNombreRazon: varchar('emisor_nombre_razon', { length: 120 }),
    emisorDomicilio: varchar('emisor_domicilio', { length: 400 }),

    /** «DescripcionOperacion» del registro de alta. */
    descripcionOperacion: varchar('descripcion_operacion', { length: 500 }),

    // --- Totales (Decimal 12,2 como exige el anexo) ---
    baseImponibleTotal: numeric('base_imponible_total', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    /** «CuotaTotal»: cuotas repercutidas + recargos de equivalencia. */
    cuotaTotal: numeric('cuota_total', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    /** «ImporteTotal» fiscal: base + cuota. NO descuenta la retención. */
    importeTotal: numeric('importe_total', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),
    retencionIrpfPorcentaje: numeric('retencion_irpf_porcentaje', {
      precision: 5,
      scale: 2,
    }),
    retencionIrpfImporte: numeric('retencion_irpf_importe', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
    /** Lo que paga el cliente: importe_total − retención IRPF. */
    totalAPagar: numeric('total_a_pagar', { precision: 12, scale: 2 })
      .notNull()
      .default('0'),

    // --- «ImporteRectificacion»: solo rectificativas por sustitución ---
    baseRectificada: numeric('base_rectificada', { precision: 12, scale: 2 }),
    cuotaRectificada: numeric('cuota_rectificada', { precision: 12, scale: 2 }),
    cuotaRecargoRectificado: numeric('cuota_recargo_rectificado', {
      precision: 12,
      scale: 2,
    }),

    /** Texto libre impreso en la factura (por eso también queda congelado). */
    observaciones: text('observaciones'),

    creadaPor: integer('creada_por').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('facturas_empresa_id_uq').on(t.empresaId, t.id),

    // FK compuestas: serie y cliente tienen que ser DE LA MISMA empresa.
    foreignKey({
      name: 'facturas_serie_fk',
      columns: [t.empresaId, t.serieId],
      foreignColumns: [seriesFacturacion.empresaId, seriesFacturacion.id],
    }),
    foreignKey({
      name: 'facturas_cliente_fk',
      columns: [t.empresaId, t.clienteId],
      foreignColumns: [clientes.empresaId, clientes.id],
    }),

    // Numeración única por serie (los borradores, con NULL, no colisionan).
    unique('facturas_serie_numero_uq').on(t.empresaId, t.serieId, t.numero),
    unique('facturas_num_serie_uq').on(t.empresaId, t.numSerieFactura),

    index('facturas_empresa_fecha_idx').on(t.empresaId, t.fechaExpedicion),
    index('facturas_empresa_estado_idx').on(t.empresaId, t.estado),
    index('facturas_empresa_cliente_idx').on(t.empresaId, t.clienteId),
    index('facturas_cobro_pendiente_idx')
      .on(t.empresaId, t.fechaExpedicion)
      .where(sql`${t.estado} = 'EMITIDA' AND ${t.estadoCobro} <> 'COBRADA'`),

    // Un borrador no tiene número; una factura emitida lo tiene todo.
    check(
      'facturas_borrador_sin_numero_ck',
      sql`${t.estado} <> 'BORRADOR' OR (${t.numero} IS NULL AND ${t.numSerieFactura} IS NULL)`
    ),
    check(
      'facturas_emitida_completa_ck',
      sql`${t.estado} = 'BORRADOR' OR (
            ${t.numero} IS NOT NULL AND ${t.numero} > 0
        AND ${t.numSerieFactura} IS NOT NULL
        AND ${t.fechaExpedicion} IS NOT NULL
        AND ${t.emitidaEn} IS NOT NULL
        AND ${t.emisorNif} IS NOT NULL
        AND ${t.emisorNombreRazon} IS NOT NULL
        AND ${t.descripcionOperacion} IS NOT NULL)`
    ),
    // Las facturas con destinatario obligatorio lo llevan identificado.
    check(
      'facturas_destinatario_ck',
      sql`${t.estado} = 'BORRADOR' OR ${t.tipoFactura} IN ('F2','R5') OR (
            ${t.destinatarioNombre} IS NOT NULL
        AND (${t.destinatarioNif} IS NOT NULL OR ${t.destinatarioIdOtroNumero} IS NOT NULL))`
    ),
    // «TipoRectificativa» se informa si y solo si la factura es R1-R5.
    check(
      'facturas_rectificativa_ck',
      sql`(${t.tipoFactura} IN ('R1','R2','R3','R4','R5')) = (${t.tipoRectificativa} IS NOT NULL)`
    ),
    check(
      'facturas_anulada_ck',
      sql`(${t.estado} = 'ANULADA') = (${t.anuladaEn} IS NOT NULL)`
    ),
  ]
);

/* ========================================================================== */
/*  7. LÍNEAS, DESGLOSE FISCAL Y FACTURAS RELACIONADAS                        */
/* ========================================================================== */

/** Líneas de detalle. Solo modificables mientras la factura es BORRADOR. */
export const facturasLineas = pgTable(
  'facturas_lineas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id').notNull(),
    facturaId: uuid('factura_id').notNull(),
    orden: smallint('orden').notNull(),

    descripcion: varchar('descripcion', { length: 500 }).notNull(),
    cantidad: numeric('cantidad', { precision: 12, scale: 3 })
      .notNull()
      .default('1'),
    precioUnitario: numeric('precio_unitario', { precision: 14, scale: 4 })
      .notNull(),
    descuentoPorcentaje: numeric('descuento_porcentaje', {
      precision: 5,
      scale: 2,
    })
      .notNull()
      .default('0'),
    /** cantidad × precio − descuento, ya redondeado a céntimos. */
    baseLinea: numeric('base_linea', { precision: 12, scale: 2 }).notNull(),

    // --- Tratamiento fiscal de la línea ---
    impuesto: varchar('impuesto', { length: 2 }).notNull().default('01'),
    claveRegimen: varchar('clave_regimen', { length: 2 }).notNull().default('01'),
    /** S1/S2 sujeta no exenta, N1/N2 no sujeta. Excluyente con operacionExenta. */
    calificacionOperacion: varchar('calificacion_operacion', { length: 2 }),
    /** E1..E6. P. ej. E1 = art. 20 LIVA (sanidad, enseñanza...). */
    operacionExenta: varchar('operacion_exenta', { length: 2 }),
    tipoImpositivo: numeric('tipo_impositivo', { precision: 5, scale: 2 }),
    cuota: numeric('cuota', { precision: 12, scale: 2 }).notNull().default('0'),
    tipoRecargoEquivalencia: numeric('tipo_recargo_equivalencia', {
      precision: 5,
      scale: 2,
    }),
    cuotaRecargoEquivalencia: numeric('cuota_recargo_equivalencia', {
      precision: 12,
      scale: 2,
    })
      .notNull()
      .default('0'),
  },
  (t) => [
    foreignKey({
      name: 'facturas_lineas_factura_fk',
      columns: [t.empresaId, t.facturaId],
      foreignColumns: [facturas.empresaId, facturas.id],
    }).onDelete('cascade'), // solo alcanzable borrando un BORRADOR
    unique('facturas_lineas_orden_uq').on(t.facturaId, t.orden),
    check(
      'facturas_lineas_calificacion_ck',
      sql`(${t.calificacionOperacion} IS NOT NULL) <> (${t.operacionExenta} IS NOT NULL)`
    ),
    check(
      'facturas_lineas_calificacion_valor_ck',
      sql`${t.calificacionOperacion} IS NULL OR ${t.calificacionOperacion} IN ('S1','S2','N1','N2')`
    ),
    check(
      'facturas_lineas_exenta_valor_ck',
      sql`${t.operacionExenta} IS NULL OR ${t.operacionExenta} IN ('E1','E2','E3','E4','E5','E6')`
    ),
    check(
      'facturas_lineas_impuesto_ck',
      sql`${t.impuesto} IN ('01','02','03','05')`
    ),
  ]
);

/**
 * Bloque «Desglose» del registro de alta: una fila por combinación de
 * impuesto / régimen / calificación / tipo. Se calcula a partir de las líneas
 * al emitir y queda congelado con la factura. Es también la base del libro
 * registro de facturas expedidas.
 */
export const facturasDesglose = pgTable(
  'facturas_desglose',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id').notNull(),
    facturaId: uuid('factura_id').notNull(),

    impuesto: varchar('impuesto', { length: 2 }).notNull().default('01'),
    claveRegimen: varchar('clave_regimen', { length: 2 }).notNull().default('01'),
    calificacionOperacion: varchar('calificacion_operacion', { length: 2 }),
    operacionExenta: varchar('operacion_exenta', { length: 2 }),
    tipoImpositivo: numeric('tipo_impositivo', { precision: 5, scale: 2 }),
    /** «BaseImponibleOimporteNoSujeto». */
    baseImponible: numeric('base_imponible', { precision: 12, scale: 2 })
      .notNull(),
    cuotaRepercutida: numeric('cuota_repercutida', { precision: 12, scale: 2 }),
    tipoRecargoEquivalencia: numeric('tipo_recargo_equivalencia', {
      precision: 5,
      scale: 2,
    }),
    cuotaRecargoEquivalencia: numeric('cuota_recargo_equivalencia', {
      precision: 12,
      scale: 2,
    }),
  },
  (t) => [
    foreignKey({
      name: 'facturas_desglose_factura_fk',
      columns: [t.empresaId, t.facturaId],
      foreignColumns: [facturas.empresaId, facturas.id],
    }).onDelete('cascade'),
    index('facturas_desglose_factura_idx').on(t.facturaId),
    check(
      'facturas_desglose_calificacion_ck',
      sql`(${t.calificacionOperacion} IS NOT NULL) <> (${t.operacionExenta} IS NOT NULL)`
    ),
  ]
);

/**
 * «FacturasRectificadas» (R1-R5) y «FacturasSustituidas» (F3).
 * Guarda siempre la identificación literal de la factura referida, porque
 * puede haberse emitido con otro programa antes de usar este sistema.
 */
export const facturasRelacionadas = pgTable(
  'facturas_relacionadas',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id').notNull(),
    facturaId: uuid('factura_id').notNull(),
    relacion: relacionFacturaEnum('relacion').notNull(),

    /** Enlace interno si la factura referida vive en este sistema. */
    facturaReferidaId: uuid('factura_referida_id'),
    referidaEmisorNif: varchar('referida_emisor_nif', { length: 9 }).notNull(),
    referidaNumSerie: varchar('referida_num_serie', { length: 60 }).notNull(),
    referidaFechaExpedicion: date('referida_fecha_expedicion').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'facturas_relacionadas_factura_fk',
      columns: [t.empresaId, t.facturaId],
      foreignColumns: [facturas.empresaId, facturas.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'facturas_relacionadas_referida_fk',
      columns: [t.empresaId, t.facturaReferidaId],
      foreignColumns: [facturas.empresaId, facturas.id],
    }),
    unique('facturas_relacionadas_uq').on(t.facturaId, t.referidaNumSerie),
    index('facturas_relacionadas_referida_idx').on(t.facturaReferidaId),
  ]
);

/* ========================================================================== */
/*  8. CADENAS FISCALES (cabecera de cada cadena)                             */
/* ========================================================================== */

/**
 * Una fila por (empresa, tipo de cadena). Es el "puntero al último eslabón"
 * y, a la vez, el cerrojo que serializa la escritura:
 *
 *   BEGIN;
 *     SELECT ultimo_id, ultima_huella FROM cadenas_fiscales
 *      WHERE empresa_id = $1 AND tipo_cadena = 'FACTURACION' FOR UPDATE;
 *     -- la app calcula la huella SHA-256 con `ultima_huella` como eslabón previo
 *     INSERT INTO registros_verifactu (...);   -- el trigger valida y avanza
 *   COMMIT;
 *
 * El bloqueo es por empresa: dos empresas nunca se esperan entre sí, y dentro
 * de una empresa es imposible que dos registros compartan el mismo anterior.
 * Las filas las crea un trigger al insertar la empresa y solo las modifican
 * los triggers de encadenamiento.
 */
export const cadenasFiscales = pgTable(
  'cadenas_fiscales',
  {
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),
    tipoCadena: tipoCadenaEnum('tipo_cadena').notNull(),
    ultimoId: uuid('ultimo_id'),
    ultimaHuella: varchar('ultima_huella', { length: 64 }),
    ultimoNumSecuencia: bigint('ultimo_num_secuencia', { mode: 'number' })
      .notNull()
      .default(0),
    ultimaGeneracion: timestamp('ultima_generacion', { withTimezone: true }),
  },
  (t) => [
    primaryKey({
      name: 'cadenas_fiscales_pk',
      columns: [t.empresaId, t.tipoCadena],
    }),
  ]
);

/* ========================================================================== */
/*  9. REGISTROS DE FACTURACIÓN VERI*FACTU (tabla de SOLO INSERCIÓN)          */
/* ========================================================================== */

/**
 * Un registro de alta o de anulación por fila. Jamás se actualiza ni se borra.
 * Una factura puede tener varios: el alta inicial, altas de subsanación y,
 * en su caso, la anulación. Todos entran en la misma y única cadena de la
 * empresa (art. 7.c y 7.d de la Orden HAC/1177/2024).
 *
 * LÓGICA DEL ENCADENAMIENTO
 *   huella(n) = SHA-256( campos del registro n  +  huella(n-1)  +  fecha-hora n )
 *   Campos que entran en la huella (art. 13 de la Orden):
 *     ALTA      → NIF emisor, nº serie+factura, fecha expedición, tipo factura,
 *                 cuota total, importe total, huella anterior, fecha-hora-huso.
 *     ANULACIÓN → NIF emisor, nº serie+factura, fecha expedición,
 *                 huella anterior, fecha-hora-huso.
 *   Cambiar un solo carácter de un registro antiguo cambia su huella y rompe
 *   todos los eslabones posteriores: por eso la cadena es verificable.
 */
export const registrosVerifactu = pgTable(
  'registros_verifactu',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),
    facturaId: uuid('factura_id').notNull(),

    /** Posición en la cadena de ESTA empresa (1, 2, 3...). La asigna el trigger. */
    numSecuencia: bigint('num_secuencia', { mode: 'number' })
      .notNull()
      .default(0),
    tipoRegistro: tipoRegistroEnum('tipo_registro').notNull(),
    /** «Subsanacion» = S: corrige un registro de alta previo de la misma factura. */
    esSubsanacion: boolean('es_subsanacion').notNull().default(false),
    /** «RechazoPrevio» (lista L17): N, S o X. */
    rechazoPrevio: varchar('rechazo_previo', { length: 1 }).notNull().default('N'),

    // --- Campos que entran en la huella (copia literal, no se recalculan) ---
    idEmisorFactura: varchar('id_emisor_factura', { length: 9 }).notNull(),
    nombreRazonEmisor: varchar('nombre_razon_emisor', { length: 120 }).notNull(),
    numSerieFactura: varchar('num_serie_factura', { length: 60 }).notNull(),
    fechaExpedicion: date('fecha_expedicion').notNull(),
    tipoFactura: tipoFacturaEnum('tipo_factura'), // solo ALTA
    cuotaTotal: numeric('cuota_total', { precision: 12, scale: 2 }), // solo ALTA
    importeTotal: numeric('importe_total', { precision: 12, scale: 2 }), // solo ALTA
    /**
     * «FechaHoraHusoGenRegistro» EXACTAMENTE como se usó en la huella
     * (YYYY-MM-DDThh:mm:ss+hh:mm). Se guarda como texto porque un timestamptz
     * pierde el huso original y la huella no podría recalcularse.
     */
    fechaHoraHusoGen: varchar('fecha_hora_huso_gen', { length: 25 }).notNull(),
    /** Mismo instante como timestamptz, para ordenar. Lo deriva el trigger. */
    generadoEn: timestamp('generado_en', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // --- Encadenamiento ---
    /** «PrimerRegistro» = S: no existe registro anterior en esta empresa. */
    esPrimerRegistro: boolean('es_primer_registro').notNull().default(false),
    registroAnteriorId: uuid('registro_anterior_id'),
    huellaAnterior: varchar('huella_anterior', { length: 64 }),
    /** «TipoHuella» (lista L12): 01 = SHA-256. */
    tipoHuella: varchar('tipo_huella', { length: 2 }).notNull().default('01'),
    huella: varchar('huella', { length: 64 }).notNull(),

    // --- Circunstancias de generación (bloque «SistemaInformatico») ---
    modo: modoVerifactuEnum('modo').notNull(),
    sifIdSistema: varchar('sif_id_sistema', { length: 2 }).notNull(),
    sifVersion: varchar('sif_version', { length: 50 }).notNull(),
    sifNumeroInstalacion: varchar('sif_numero_instalacion', { length: 100 })
      .notNull(),

    // --- Contenido completo conservado ---
    /** Registro íntegro en XML; en NO VERI*FACTU incluye la firma XAdES. */
    xmlRegistro: text('xml_registro').notNull(),
    xmlFirmado: boolean('xml_firmado').notNull().default(false),
    /** URL codificada en el QR (art. 21 Orden). Solo registros de ALTA. */
    qrUrl: text('qr_url'),

    creadoPor: integer('creado_por').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('registros_empresa_id_uq').on(t.empresaId, t.id),

    // El registro pertenece a una factura DE LA MISMA empresa.
    foreignKey({
      name: 'registros_factura_fk',
      columns: [t.empresaId, t.facturaId],
      foreignColumns: [facturas.empresaId, facturas.id],
    }),

    // ---- AISLAMIENTO DE LA CADENA POR EMPRESA ----
    // (1) El eslabón anterior tiene que ser un registro de la MISMA empresa.
    foreignKey({
      name: 'registros_anterior_fk',
      columns: [t.empresaId, t.registroAnteriorId],
      foreignColumns: [t.empresaId, t.id],
    }),
    // (2) Sin bifurcaciones: un registro solo puede ser "anterior" de uno.
    unique('registros_sin_bifurcacion_uq').on(t.empresaId, t.registroAnteriorId),
    // (3) Un único primer registro por empresa.
    uniqueIndex('registros_un_primero_uq')
      .on(t.empresaId)
      .where(sql`${t.registroAnteriorId} IS NULL`),
    // (4) Secuencia propia y sin repetidos dentro de cada empresa.
    unique('registros_secuencia_uq').on(t.empresaId, t.numSecuencia),
    unique('registros_huella_uq').on(t.empresaId, t.huella),

    // Un solo alta "inicial" por factura; el resto son subsanaciones.
    uniqueIndex('registros_un_alta_inicial_uq')
      .on(t.facturaId)
      .where(sql`${t.tipoRegistro} = 'ALTA' AND NOT ${t.esSubsanacion}`),
    index('registros_factura_idx').on(t.empresaId, t.facturaId),

    check(
      'registros_primer_registro_ck',
      sql`(${t.esPrimerRegistro} AND ${t.registroAnteriorId} IS NULL AND ${t.huellaAnterior} IS NULL)
       OR (NOT ${t.esPrimerRegistro} AND ${t.registroAnteriorId} IS NOT NULL AND ${t.huellaAnterior} IS NOT NULL)`
    ),
    check('registros_huella_formato_ck', sql`${t.huella} ~ '^[0-9A-F]{64}$'`),
    check(
      'registros_huella_anterior_formato_ck',
      sql`${t.huellaAnterior} IS NULL OR ${t.huellaAnterior} ~ '^[0-9A-F]{64}$'`
    ),
    check(
      'registros_fecha_hora_formato_ck',
      sql`${t.fechaHoraHusoGen} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$'`
    ),
    check('registros_rechazo_previo_ck', sql`${t.rechazoPrevio} IN ('N','S','X')`),
    check(
      'registros_alta_completa_ck',
      sql`${t.tipoRegistro} <> 'ALTA' OR (
            ${t.tipoFactura} IS NOT NULL AND ${t.cuotaTotal} IS NOT NULL
        AND ${t.importeTotal} IS NOT NULL AND ${t.qrUrl} IS NOT NULL)`
    ),
    check(
      'registros_anulacion_ck',
      sql`${t.tipoRegistro} <> 'ANULACION' OR NOT ${t.esSubsanacion}`
    ),
    // En NO VERI*FACTU el registro conservado tiene que ir firmado.
    check(
      'registros_firma_ck',
      sql`${t.modo} = 'VERIFACTU' OR ${t.xmlFirmado}`
    ),
  ]
);

/* ========================================================================== */
/*  10. COLA DE REMISIÓN A LA AEAT                                            */
/* ========================================================================== */

/**
 * Estado operativo del envío, separado a propósito del registro fiscal: así
 * `registros_verifactu` puede ser 100 % inmutable y aquí se actualiza con
 * libertad (reintentos, respuesta de la AEAT). Relación 1:1; la fila la crea
 * un trigger al insertar el registro (PENDIENTE o NO_APLICA según el modo).
 * Los envíos se hacen por empresa y en orden de `num_secuencia`.
 */
export const enviosAeat = pgTable(
  'envios_aeat',
  {
    registroId: uuid('registro_id').primaryKey(),
    empresaId: uuid('empresa_id').notNull(),
    numSecuencia: bigint('num_secuencia', { mode: 'number' }).notNull(),

    estado: estadoEnvioEnum('estado').notNull(),
    intentos: integer('intentos').notNull().default(0),
    proximoIntentoEn: timestamp('proximo_intento_en', { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** Agrupa los registros remitidos en un mismo mensaje (máx. 1.000). */
    loteId: uuid('lote_id'),
    enviadoEn: timestamp('enviado_en', { withTimezone: true }),
    respondidoEn: timestamp('respondido_en', { withTimezone: true }),

    /** Código Seguro de Verificación devuelto por la AEAT. */
    csv: varchar('csv', { length: 50 }),
    codigoError: varchar('codigo_error', { length: 10 }),
    descripcionError: text('descripcion_error'),
    respuestaAeat: jsonb('respuesta_aeat'),

    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: 'envios_aeat_registro_fk',
      columns: [t.empresaId, t.registroId],
      foreignColumns: [registrosVerifactu.empresaId, registrosVerifactu.id],
    }),
    // Índice de trabajo del worker: qué toca enviar ya.
    index('envios_aeat_cola_idx')
      .on(t.proximoIntentoEn, t.empresaId, t.numSecuencia)
      .where(sql`${t.estado} IN ('PENDIENTE','ERROR_TRANSITORIO')`),
    index('envios_aeat_empresa_estado_idx').on(t.empresaId, t.estado),
    index('envios_aeat_lote_idx').on(t.loteId),
  ]
);

/* ========================================================================== */
/*  11. REGISTRO DE EVENTOS (tabla de SOLO INSERCIÓN)                         */
/* ========================================================================== */

/**
 * Registro de eventos del art. 9 de la Orden HAC/1177/2024, exigible cuando
 * la empresa opera en modo NO VERI*FACTU. Tiene su propia cadena de huellas
 * por empresa, independiente de la de facturación, con las mismas garantías.
 *
 * Campos de la huella de evento (art. 13.1.c): productor del SIF, id del SIF,
 * versión, número de instalación, NIF del obligado, tipo de evento, huella
 * del evento anterior y fecha-hora-huso de generación.
 */
export const eventosLog = pgTable(
  'eventos_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    empresaId: uuid('empresa_id')
      .notNull()
      .references(() => empresas.id),
    numSecuencia: bigint('num_secuencia', { mode: 'number' })
      .notNull()
      .default(0),

    /** Lista L2E: 01..10 obligatorios, 90 = voluntarios del productor. */
    tipoEvento: varchar('tipo_evento', { length: 2 }).notNull(),
    /** «OtrosDatosEvento». */
    otrosDatos: varchar('otros_datos', { length: 100 }),
    /** «DatosPropiosEvento» (anomalías, exportaciones, resumen...). */
    detalle: jsonb('detalle'),

    usuarioId: integer('usuario_id').references(() => users.id),
    ipOrigen: varchar('ip_origen', { length: 45 }),

    // --- Campos que entran en la huella ---
    nifObligado: varchar('nif_obligado', { length: 9 }).notNull(),
    sifNifProductor: varchar('sif_nif_productor', { length: 9 }).notNull(),
    sifIdSistema: varchar('sif_id_sistema', { length: 2 }).notNull(),
    sifVersion: varchar('sif_version', { length: 50 }).notNull(),
    sifNumeroInstalacion: varchar('sif_numero_instalacion', { length: 100 })
      .notNull(),
    fechaHoraHusoGen: varchar('fecha_hora_huso_gen', { length: 25 }).notNull(),
    generadoEn: timestamp('generado_en', { withTimezone: true })
      .notNull()
      .defaultNow(),

    // --- Encadenamiento (misma mecánica que registros_verifactu) ---
    esPrimerEvento: boolean('es_primer_evento').notNull().default(false),
    eventoAnteriorId: uuid('evento_anterior_id'),
    huellaAnterior: varchar('huella_anterior', { length: 64 }),
    tipoHuella: varchar('tipo_huella', { length: 2 }).notNull().default('01'),
    huella: varchar('huella', { length: 64 }).notNull(),

    /** Registro de evento íntegro en XML, con su firma XAdES. */
    xmlEvento: text('xml_evento').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique('eventos_empresa_id_uq').on(t.empresaId, t.id),
    foreignKey({
      name: 'eventos_anterior_fk',
      columns: [t.empresaId, t.eventoAnteriorId],
      foreignColumns: [t.empresaId, t.id],
    }),
    unique('eventos_sin_bifurcacion_uq').on(t.empresaId, t.eventoAnteriorId),
    uniqueIndex('eventos_un_primero_uq')
      .on(t.empresaId)
      .where(sql`${t.eventoAnteriorId} IS NULL`),
    unique('eventos_secuencia_uq').on(t.empresaId, t.numSecuencia),
    index('eventos_empresa_tipo_idx').on(t.empresaId, t.tipoEvento, t.generadoEn),
    check(
      'eventos_tipo_ck',
      sql`${t.tipoEvento} IN ('01','02','03','04','05','06','07','08','09','10','90')`
    ),
    check(
      'eventos_primer_evento_ck',
      sql`(${t.esPrimerEvento} AND ${t.eventoAnteriorId} IS NULL AND ${t.huellaAnterior} IS NULL)
       OR (NOT ${t.esPrimerEvento} AND ${t.eventoAnteriorId} IS NOT NULL AND ${t.huellaAnterior} IS NOT NULL)`
    ),
    check('eventos_huella_formato_ck', sql`${t.huella} ~ '^[0-9A-F]{64}$'`),
    check(
      'eventos_fecha_hora_formato_ck',
      sql`${t.fechaHoraHusoGen} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$'`
    ),
  ]
);

/* ========================================================================== */
/*  12. RELACIONES (API relacional de Drizzle)                                */
/* ========================================================================== */

export const teamsRelations = relations(teams, ({ many }) => ({
  teamMembers: many(teamMembers),
  activityLogs: many(activityLogs),
  invitations: many(invitations),
  empresas: many(empresas),
}));

export const usersRelations = relations(users, ({ many }) => ({
  teamMembers: many(teamMembers),
  invitationsSent: many(invitations),
}));

export const invitationsRelations = relations(invitations, ({ one }) => ({
  team: one(teams, {
    fields: [invitations.teamId],
    references: [teams.id],
  }),
  invitedBy: one(users, {
    fields: [invitations.invitedBy],
    references: [users.id],
  }),
}));

export const teamMembersRelations = relations(teamMembers, ({ one }) => ({
  user: one(users, {
    fields: [teamMembers.userId],
    references: [users.id],
  }),
  team: one(teams, {
    fields: [teamMembers.teamId],
    references: [teams.id],
  }),
}));

export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  team: one(teams, {
    fields: [activityLogs.teamId],
    references: [teams.id],
  }),
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
}));

export const empresasRelations = relations(empresas, ({ one, many }) => ({
  team: one(teams, { fields: [empresas.teamId], references: [teams.id] }),
  clientes: many(clientes),
  series: many(seriesFacturacion),
  facturas: many(facturas),
  registros: many(registrosVerifactu),
  eventos: many(eventosLog),
  cadenas: many(cadenasFiscales),
}));

export const clientesRelations = relations(clientes, ({ one, many }) => ({
  empresa: one(empresas, {
    fields: [clientes.empresaId],
    references: [empresas.id],
  }),
  facturas: many(facturas),
}));

export const seriesFacturacionRelations = relations(
  seriesFacturacion,
  ({ one, many }) => ({
    empresa: one(empresas, {
      fields: [seriesFacturacion.empresaId],
      references: [empresas.id],
    }),
    facturas: many(facturas),
  })
);

export const facturasRelations = relations(facturas, ({ one, many }) => ({
  empresa: one(empresas, {
    fields: [facturas.empresaId],
    references: [empresas.id],
  }),
  serie: one(seriesFacturacion, {
    fields: [facturas.serieId],
    references: [seriesFacturacion.id],
  }),
  cliente: one(clientes, {
    fields: [facturas.clienteId],
    references: [clientes.id],
  }),
  lineas: many(facturasLineas),
  desglose: many(facturasDesglose),
  relacionadas: many(facturasRelacionadas, { relationName: 'origen' }),
  referidaPor: many(facturasRelacionadas, { relationName: 'referida' }),
  registros: many(registrosVerifactu),
}));

export const facturasLineasRelations = relations(facturasLineas, ({ one }) => ({
  factura: one(facturas, {
    fields: [facturasLineas.facturaId],
    references: [facturas.id],
  }),
}));

export const facturasDesgloseRelations = relations(
  facturasDesglose,
  ({ one }) => ({
    factura: one(facturas, {
      fields: [facturasDesglose.facturaId],
      references: [facturas.id],
    }),
  })
);

export const facturasRelacionadasRelations = relations(
  facturasRelacionadas,
  ({ one }) => ({
    factura: one(facturas, {
      fields: [facturasRelacionadas.facturaId],
      references: [facturas.id],
      relationName: 'origen',
    }),
    facturaReferida: one(facturas, {
      fields: [facturasRelacionadas.facturaReferidaId],
      references: [facturas.id],
      relationName: 'referida',
    }),
  })
);

export const cadenasFiscalesRelations = relations(cadenasFiscales, ({ one }) => ({
  empresa: one(empresas, {
    fields: [cadenasFiscales.empresaId],
    references: [empresas.id],
  }),
}));

export const registrosVerifactuRelations = relations(
  registrosVerifactu,
  ({ one }) => ({
    empresa: one(empresas, {
      fields: [registrosVerifactu.empresaId],
      references: [empresas.id],
    }),
    factura: one(facturas, {
      fields: [registrosVerifactu.facturaId],
      references: [facturas.id],
    }),
    registroAnterior: one(registrosVerifactu, {
      fields: [registrosVerifactu.registroAnteriorId],
      references: [registrosVerifactu.id],
      relationName: 'cadena',
    }),
    envio: one(enviosAeat, {
      fields: [registrosVerifactu.id],
      references: [enviosAeat.registroId],
    }),
  })
);

export const enviosAeatRelations = relations(enviosAeat, ({ one }) => ({
  registro: one(registrosVerifactu, {
    fields: [enviosAeat.registroId],
    references: [registrosVerifactu.id],
  }),
}));

export const eventosLogRelations = relations(eventosLog, ({ one }) => ({
  empresa: one(empresas, {
    fields: [eventosLog.empresaId],
    references: [empresas.id],
  }),
  eventoAnterior: one(eventosLog, {
    fields: [eventosLog.eventoAnteriorId],
    references: [eventosLog.id],
    relationName: 'cadenaEventos',
  }),
  usuario: one(users, {
    fields: [eventosLog.usuarioId],
    references: [users.id],
  }),
}));

/* ========================================================================== */
/*  13. TIPOS                                                                 */
/* ========================================================================== */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
export type Invitation = typeof invitations.$inferSelect;
export type NewInvitation = typeof invitations.$inferInsert;
export type TeamDataWithMembers = Team & {
  teamMembers: (TeamMember & {
    user: Pick<User, 'id' | 'name' | 'email'>;
  })[];
};

export type Empresa = typeof empresas.$inferSelect;
export type NewEmpresa = typeof empresas.$inferInsert;
export type Cliente = typeof clientes.$inferSelect;
export type NewCliente = typeof clientes.$inferInsert;
export type SerieFacturacion = typeof seriesFacturacion.$inferSelect;
export type NewSerieFacturacion = typeof seriesFacturacion.$inferInsert;
export type Factura = typeof facturas.$inferSelect;
export type NewFactura = typeof facturas.$inferInsert;
export type FacturaLinea = typeof facturasLineas.$inferSelect;
export type NewFacturaLinea = typeof facturasLineas.$inferInsert;
export type FacturaDesglose = typeof facturasDesglose.$inferSelect;
export type NewFacturaDesglose = typeof facturasDesglose.$inferInsert;
export type FacturaRelacionada = typeof facturasRelacionadas.$inferSelect;
export type NewFacturaRelacionada = typeof facturasRelacionadas.$inferInsert;
export type CadenaFiscal = typeof cadenasFiscales.$inferSelect;
export type RegistroVerifactu = typeof registrosVerifactu.$inferSelect;
export type NewRegistroVerifactu = typeof registrosVerifactu.$inferInsert;
export type EnvioAeat = typeof enviosAeat.$inferSelect;
export type EventoLog = typeof eventosLog.$inferSelect;
export type NewEventoLog = typeof eventosLog.$inferInsert;

export enum ActivityType {
  SIGN_UP = 'SIGN_UP',
  SIGN_IN = 'SIGN_IN',
  SIGN_OUT = 'SIGN_OUT',
  UPDATE_PASSWORD = 'UPDATE_PASSWORD',
  DELETE_ACCOUNT = 'DELETE_ACCOUNT',
  UPDATE_ACCOUNT = 'UPDATE_ACCOUNT',
  CREATE_TEAM = 'CREATE_TEAM',
  REMOVE_TEAM_MEMBER = 'REMOVE_TEAM_MEMBER',
  INVITE_TEAM_MEMBER = 'INVITE_TEAM_MEMBER',
  ACCEPT_INVITATION = 'ACCEPT_INVITATION',
  // --- Facturación ---
  CREATE_EMPRESA = 'CREATE_EMPRESA',
  CREATE_SERIE = 'CREATE_SERIE',
  UPDATE_SERIE = 'UPDATE_SERIE',
  DELETE_SERIE = 'DELETE_SERIE',
}
