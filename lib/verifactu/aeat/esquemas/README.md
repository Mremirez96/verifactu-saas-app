# Esquemas oficiales de la AEAT (VERI\*FACTU)

Copia sin modificar de los XSD que publica la Agencia Tributaria en su sede
electrónica (apartado «Información técnica» → «Esquemas») para los servicios
web de remisión de registros de facturación, más el esquema de firma XML del
W3C que estos importan.

| Fichero | Contenido |
|---|---|
| `SuministroLR.xsd` | Mensaje de remisión `RegFactuSistemaFacturacion` |
| `SuministroInformacion.xsd` | Cabecera, `RegistroAlta` y `RegistroAnulacion` |
| `RespuestaSuministro.xsd` | Respuesta `RespuestaRegFactuSistemaFacturacion` |
| `xmldsig-core-schema.xsd` | Firma XML (W3C), importado por el anterior |

**Solo se usan en los tests**, para validar con `xmllint` que el XML que genera
la aplicación cumple el esquema. La aplicación no los carga en ejecución.

Cuando la AEAT publique una versión nueva de los esquemas, sustituya estos
ficheros por los nuevos y ejecute `pnpm test`: los tests dirán qué ha dejado
de cumplir.
