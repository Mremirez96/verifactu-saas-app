# Fase 4 · Conectividad con la AEAT

Remisión de los registros de facturación a los servicios web de la Agencia
Tributaria (modo VERI\*FACTU), cola de reintentos para contingencias y controles
del modo NO VERI\*FACTU.

Normativa de referencia: RD 1007/2023 (arts. 8, 14, 15 y 16) y Orden
HAC/1177/2024 (arts. 14, 16, 17 y 18, y anexo). Los detalles de protocolo salen
del WSDL y los XSD oficiales (`esquemas/`).

## 1. Visión general

```
 emitirFactura / anularFactura            (Fases 2-3, misma transacción)
   └─ registros_verifactu  ──trigger──►  envios_aeat   PENDIENTE  (VERI*FACTU)
        XML + huella, inalterable                      NO_APLICA  (NO VERI*FACTU)
                                              │
            remitirTrasEmision (tiempo real)  │  worker cada minuto (/api/cron/aeat)
                                              ▼
                                   remision.ts  (por empresa)
              ┌─ 1. RESERVA      tx corta: cerrojo, control de flujo, lote EN_CURSO
              ├─ 2. ENVÍO        sin transacción: SOAP 1.1 sobre HTTPS con certificado
              └─ 3. LIQUIDACIÓN  tx corta: estado de cada registro, CSV, próximo envío
                                              │
                                              ▼
                               AEAT  …/SistemaFacturacion/VerifactuSOAP
```

| Fichero | Responsabilidad |
|---|---|
| `registro-xml.ts` | XML de `RegistroAlta` y `RegistroAnulacion` (puro; validado contra el XSD) |
| `soap.ts` | Sobre `RegFactuSistemaFacturacion` y lectura de la respuesta o del SOAP Fault (puro) |
| `transporte.ts` | POST HTTPS con TLS mutuo; distingue «no salió» de «salió y no sé qué pasó» |
| `respuesta.ts` | Qué significa cada respuesta: estado de cada registro, fallo transitorio o rechazo del envío (puro) |
| `reintentos.ts` | Control de flujo y espera exponencial (puro) |
| `remision.ts` | La cola: reserva, envío, liquidación, worker y estado para la interfaz |
| `no-verifactu.ts` | Requerimiento, exportación y verificación de la conservación |
| `config.ts` | Direcciones de la AEAT y certificado |
| `planificador.ts` | Worker dentro del proceso (opcional) |

## 2. Cliente SOAP

- **Operación** `RegFactuSistemaFacturacion`, SOAP 1.1 document/literal, UTF-8,
  de 1 a 1.000 registros por mensaje, altas y anulaciones mezcladas.
- **Direcciones** (WSDL oficial):

  | Entorno | Certificado | Host |
  |---|---|---|
  | Producción | persona / representante | `www1.agenciatributaria.gob.es` |
  | Producción | sello electrónico | `www10.agenciatributaria.gob.es` |
  | Pruebas | persona / representante | `prewww1.aeat.es` |
  | Pruebas | sello electrónico | `prewww10.aeat.es` |

  Ruta `/wlpl/TIKE-CONT/ws/SistemaFacturacion/VerifactuSOAP` (remisión
  voluntaria) o `…/RequerimientoSOAP` (respuesta a requerimiento).
- **Autenticación**: certificado electrónico de cliente. Su titular tiene que
  ser el obligado, un apoderado o un colaborador social.
- **Los registros no se regeneran al enviar**: se incrusta el XML guardado al
  emitir, cuya huella ya está calculada. `RefExterna` lleva el identificador
  interno del registro y sirve para casar cada línea de la respuesta.

## 3. Estados de `envios_aeat`

```
   PENDIENTE ─┐                        ┌─► ACEPTADO               CSV
              ├─► ENVIANDO ────────────┼─► ACEPTADO_CON_ERRORES   CSV + código (hay que subsanar)
 ERROR_TRANSITORIO ◄── fallo técnico ──└─► RECHAZADO              código (registro nuevo corregido)

   NO_APLICA   registro NO VERI*FACTU: final desde que nace
```

Los cuatro estados de la derecha y `NO_APLICA` son finales; lo impone el
trigger `vf_envios_guard` (migración 0005), no solo el código.

| Lo que ocurre | Clasificación | Efecto |
|---|---|---|
| Respuesta con `EstadoRegistro` por línea | RESPUESTA | Cada registro a su estado final. CSV en los aceptados |
| Sin conexión, timeout, HTTP 5xx/408/429, Fault `Server`, cuerpo ilegible | TRANSITORIO | Vuelven a la cola; reintento con espera exponencial |
| Fault `Client` (4xxx: esquema, cabecera, certificado), HTTP 4xx | RECHAZO DEL ENVÍO | Vuelven a la cola, **no** se marcan `RECHAZADO`; la empresa queda en `requiere_intervencion` y se avanza de uno en uno |

**Duplicados.** Si un intento quedó sin respuesta (`entrega_incierta`), puede
que la AEAT sí lo registrara. Al reenviar contesta «duplicado» con el bloque
`RegistroDuplicado`; en ese caso se toma como confirmación y el registro queda
aceptado (sin CSV, con `conciliado: true` en `respuesta_aeat`). Un duplicado sin
intento incierto previo es un rechazo real.

**Evidencia.** Cada mensaje es una fila de `aeat_lotes`: servicio, registros,
huella SHA-256 de la petición, respuesta íntegra de la AEAT, CSV y resultado.
Un lote cerrado no se puede modificar ni borrar.

## 4. Cola, control de flujo y reintentos

- **Orden** (art. 16.4): un único mensaje en vuelo por empresa y siempre los
  registros más antiguos primero. Cerrojo: fila de `aeat_control_flujo` con
  `FOR UPDATE SKIP LOCKED`.
- **Control de flujo** (art. 16.2): espera de `t` segundos entre envíos (60 al
  empezar; la AEAT lo actualiza en `TiempoEsperaEnvio`), salvo que haya 1.000
  registros acumulados.
- **Reintentos** (art. 16.4): 1, 2, 4, 8, 16, 32 y 60 minutos; el tope de una
  hora cumple el «al menos una vez cada hora». Hasta un 10 % menos al azar para
  no sincronizar a todas las empresas tras una caída.
- **Incidencia**: desde el primer fallo y hasta vaciar la cola, los mensajes
  llevan `Incidencia = S`, y `estadoRemision()` devuelve el aviso obligatorio
  con el número de registros que faltan por remitir.
- **Caída del proceso a mitad de envío**: el lote lleva un arrendamiento
  (timeout de red + 60 s). Al caducar, otro worker devuelve los registros a la
  cola como inciertos y los reenvía.

### Puesta en marcha del worker

Una pasada por minuto, de una de estas dos formas:

```bash
# a) Tarea programada (Vercel Cron, cron del sistema, planificador en la nube…)
curl -H "Authorization: Bearer $CRON_SECRET" https://su-dominio/api/cron/aeat

# b) Servidor de larga vida: temporizador en el propio proceso
VERIFACTU_COLA_INTERVALO_SEG=60
```

Y, tras emitir o anular, el envío inmediato:

```ts
const { registro } = await emitirFactura(ctx, empresaId, facturaId);
after(() => remitirTrasEmision(registro.empresaId)); // next/server
```

## 5. Modo NO VERI\*FACTU

Los registros se conservan en local, encadenados y firmados, y no se remiten
de forma automática. Tres barreras:

1. **Base de datos**: nacen `NO_APLICA`, estado final al que nadie puede entrar
   ni del que nadie puede salir después.
2. **Cola**: solo toma `PENDIENTE` / `ERROR_TRANSITORIO` y aborta si encuentra
   un registro de otro modo.
3. **Salidas manuales**, solo para el propietario de la cuenta y anotadas:
   - `remitirPorRequerimiento()` → servicio `RequerimientoSOAP`, con
     `RefRequerimiento` en todos los mensajes y `FinRequerimiento = S` en el
     último (art. 14.2 RD y art. 18 Orden).
   - `exportarRegistros()` → un XML por registro (art. 8.2.c RD).
   - `verificarConservacion()` → cadena íntegra, todo firmado, nada en la cola.

El modo se decide registro a registro: si una empresa deja VERI\*FACTU, los
registros que generó en ese modo y aún no remitió se siguen enviando.

## 6. Tests

```bash
pnpm test      # generador XML contra el XSD, SOAP, clasificación, reintentos, transporte
pnpm test:db   # integración: PostgreSQL real + simulador local de la AEAT
```

La validación XSD usa `xmllint` (paquete `libxml2-utils`); si no está
instalado, esos tests se marcan como omitidos.

## 7. Pendiente y límites conocidos

- **Sin probar contra la AEAT real.** Todo está verificado contra los XSD
  oficiales y un simulador. Falta la prueba en el entorno de pruebas de la AEAT
  con un certificado real; es el siguiente paso obligado antes de producción.
- **Emisión en modo NO VERI\*FACTU**: sigue bloqueada hasta tener la firma
  XAdES (art. 14 Orden) y el registro de eventos. Los controles de este modo se
  prueban con una firma simulada.
- **Corrección tras un rechazo**: un registro `RECHAZADO` o
  `ACEPTADO_CON_ERRORES` exige generar un registro nuevo (`Subsanacion`,
  `RechazoPrevio`). El XML ya admite esos campos; falta el servicio que los genera.
- **Rechazo del envío completo**: la empresa queda señalada y se sigue
  reintentando (como mucho cada hora), pero no hay todavía herramienta de
  soporte para resolver el caso.
- **Renuncia a VERI\*FACTU** (`FechaFinVeriFactu`, art. 17.3): el mensaje lo
  admite; falta guardarlo en la empresa y la pantalla que lo fija.
