import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NS } from '../xml';

/**
 * Validación contra los XSD oficiales de la AEAT (solo para tests).
 *
 * Usa `xmllint` (libxml2), que viene instalado en macOS y en casi cualquier
 * Linux (paquete `libxml2-utils`). Si no está, `xsdDisponible` es `false` y
 * los tests que dependen de él se marcan como omitidos, no como superados.
 *
 * Los esquemas se copian a un directorio temporal con dos retoques para poder
 * validar SIN RED: el XSD de la AEAT importa el de firma XML por su URL en
 * w3.org, y este declara un DOCTYPE externo. Los ficheros del repositorio no
 * se tocan.
 */
const ORIGEN = join(__dirname, '..', 'esquemas');

function prepararEsquemas(): string | null {
  if (spawnSync('xmllint', ['--version']).error) return null;
  const destino = mkdtempSync(join(tmpdir(), 'vf-xsd-'));
  for (const fichero of ['SuministroLR.xsd', 'RespuestaSuministro.xsd']) {
    writeFileSync(join(destino, fichero), readFileSync(join(ORIGEN, fichero)));
  }
  writeFileSync(
    join(destino, 'SuministroInformacion.xsd'),
    readFileSync(join(ORIGEN, 'SuministroInformacion.xsd'), 'utf8').replace(
      'http://www.w3.org/TR/xmldsig-core/xmldsig-core-schema.xsd',
      'xmldsig-core-schema.xsd'
    )
  );
  writeFileSync(
    join(destino, 'xmldsig-core-schema.xsd'),
    readFileSync(join(ORIGEN, 'xmldsig-core-schema.xsd'), 'utf8')
      .replace(/<!DOCTYPE[\s\S]*?\]>/, '')
      .replace(/&dsig;/g, 'http://www.w3.org/2000/09/xmldsig#')
  );
  return destino;
}

const directorio = prepararEsquemas();
export const xsdDisponible = directorio !== null;

export type Esquema = 'SuministroInformacion.xsd' | 'SuministroLR.xsd' | 'RespuestaSuministro.xsd';

/** Devuelve `null` si el XML cumple el esquema, o el texto de los errores. */
export function erroresXsd(xml: string, esquema: Esquema): string | null {
  if (!directorio) throw new Error('xmllint no está disponible');
  try {
    execFileSync('xmllint', ['--noout', '--nonet', '--schema', join(directorio, esquema), '-'], {
      input: xml,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return null;
  } catch (error) {
    return String((error as { stderr?: Buffer }).stderr ?? error);
  }
}

/**
 * Extrae del sobre SOAP el elemento de negocio (hijo de «Body») como
 * documento independiente, declarando en él los espacios de nombres que en
 * el mensaje se declaran en el sobre.
 */
export function cuerpoSoap(sobre: string): string {
  const cuerpo = /<soapenv:Body>([\s\S]*)<\/soapenv:Body>/.exec(sobre)?.[1];
  if (!cuerpo) throw new Error('El mensaje no tiene soapenv:Body');
  return cuerpo.replace(
    /^<sum:RegFactuSistemaFacturacion/,
    `<sum:RegFactuSistemaFacturacion xmlns:sum="${NS.sum}" xmlns:sum1="${NS.sum1}"`
  );
}
