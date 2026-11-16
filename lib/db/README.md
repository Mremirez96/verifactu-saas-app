# Base de datos: esquema, migraciones y roles

## Dos credenciales, dos papeles

| Variable | Rol | Para qué | Dónde debe existir |
|---|---|---|---|
| `POSTGRES_MIGRATION_URL` | **Propietario** del esquema (necesita `CREATEROLE`) | `drizzle-kit` (generar/aplicar migraciones, studio) y `pnpm db:roles` | Solo en CI/despliegue y en local. **No** en el entorno de ejecución de la app |
| `POSTGRES_URL` | Usuario de la **aplicación**, miembro del rol de grupo `verifactu_app` | Todo lo que hace la app en ejecución | Entorno de ejecución |

**Por qué.** Las guardas VERI\*FACTU (inalterabilidad, numeración, encadenamiento)
son triggers. El propietario de una tabla puede desactivarlos y un superusuario
puede saltárselos; si la app se conectara con cualquiera de los dos, serían
opcionales. Con el rol acotado, la app no puede desactivarlos y, además, carece
del permiso mismo para lo que los triggers prohíben.

## Qué puede hacer la aplicación

| Tabla | Permisos del rol `verifactu_app` |
|---|---|
| `users`, `teams`, `team_members`, `activity_logs`, `invitations` | leer, insertar, actualizar, borrar |
| `empresas` | leer, insertar, actualizar (sin borrar) |
| `clientes` | leer, insertar, actualizar, borrar |
| `series_facturacion` | leer, insertar, borrar; actualizar **salvo** `ultimo_numero` y `ultima_fecha_expedicion` |
| `facturas`, `facturas_lineas`, `facturas_desglose`, `facturas_relacionadas` | leer, insertar, actualizar, borrar (el ciclo de vida lo gobiernan los triggers) |
| `registros_verifactu`, `eventos_log` | **solo** leer e insertar |
| `envios_aeat` | leer; actualizar solo las columnas de estado del envío |
| `cadenas_fiscales` | **solo** leer; el cerrojo se toma con `vf_bloquear_cadena()` |

`TRUNCATE`, `REFERENCES`, `TRIGGER` y la creación de objetos no se conceden en
ningún caso. No hay privilegios por defecto: **una tabla nueva es inaccesible
para la app hasta que una migración le concede permisos explícitos.**

Los triggers que escriben donde la app no puede (contador de series, cabeceras
de cadena, cola de envíos) son `SECURITY DEFINER`: se ejecutan con los permisos
del propietario.

## Puesta en marcha

```bash
pnpm db:setup     # crea .env con las dos URLs (genera la contraseña de la app)
pnpm db:migrate   # como PROPIETARIO: tablas, triggers, rol de grupo y permisos
pnpm db:roles     # crea el usuario de POSTGRES_URL y lo une a verifactu_app
pnpm db:seed      # como APLICACIÓN
```

`pnpm db:roles` es idempotente; sirve también para rotar la contraseña (cámbiela
en `POSTGRES_URL` y vuelva a ejecutarlo). Si su proveedor no permite crear roles
por SQL, cree a mano un usuario sin privilegios y ejecute
`GRANT verifactu_app TO <usuario>;`.

## Verificación al arrancar

`instrumentation.ts` llama a `verificarRolBaseDatos()` al iniciar el servidor.
Consulta el catálogo de PostgreSQL y comprueba que el rol conectado no es
superusuario, no es (ni pertenece a) el propietario de las tablas y no tiene
permisos de más sobre las tablas fiscales.

- En **producción**, si el rol es excesivo, la aplicación **no arranca**.
- En **desarrollo**, muestra un aviso y continúa.

## Migraciones

| Fichero | Origen | Contenido |
|---|---|---|
| `0000_soft_the_anarchist.sql` | generado | Tablas del starter |
| `0001_verifactu_modelo.sql` | generado desde `schema.ts` | Modelo fiscal multi-tenant |
| `0002_verifactu_guardas.sql` | **a mano** | Triggers de inalterabilidad, numeración y encadenamiento |
| `0003_verifactu_privilegios.sql` | **a mano** | Rol `verifactu_app`, permisos, `SECURITY DEFINER`, `vf_bloquear_cadena()` |

Al añadir tablas: `pnpm db:generate` para el modelo y, después, una migración
`drizzle-kit generate --custom` con sus `GRANT` (y sus triggers si los necesita).
Las migraciones ya aplicadas no se editan.

## Tests

```bash
pnpm test:db   # contra una BD desechable ya migrada, con POSTGRES_URL de la app
```

Comprueban los privilegios del rol, el alta de empresa, el aislamiento entre
cuentas y la gestión de series. Dejan datos (las empresas no se pueden borrar).
