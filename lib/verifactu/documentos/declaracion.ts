import { CARACTERISTICAS_SIF, datosProductor, SISTEMA_INFORMATICO } from '../sif';

/**
 * DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN
 * (art. 13 del RD 1007/2023 y art. 15 de la Orden HAC/1177/2024).
 *
 * DÓNDE TIENE QUE ESTAR
 *   La norma exige que conste «por escrito y de modo visible en el propio
 *   sistema informático», accesible para el usuario «de forma rápida, fácil e
 *   intuitiva». NO exige imprimirla en cada factura: lo obligatorio en la
 *   factura es el QR y, en VERI*FACTU, la frase de factura verificable.
 *
 *   Por eso aquí hay dos cosas distintas:
 *     · `declaracionResponsable()` → el documento completo, que se muestra en
 *       la página /declaracion-responsable (enlazada desde el menú).
 *     · `mencionSif()`             → la línea del pie de facturas y tickets,
 *       que identifica el sistema y remite a esa declaración.
 */

export const TITULO_DECLARACION = 'DECLARACIÓN RESPONSABLE DEL SISTEMA INFORMÁTICO DE FACTURACIÓN';

export type ApartadoDeclaracion = {
  letra: string;
  /** Texto que describe el dato y debe precederlo (art. 15.1). */
  descripcion: string;
  /** `null` = dato que todavía no ha aportado el productor. */
  valor: string | null;
};

export type DeclaracionResponsable = {
  titulo: typeof TITULO_DECLARACION;
  apartados: ApartadoDeclaracion[];
  /** Solo es una declaración válida cuando no falta ningún dato. */
  completa: boolean;
  pendientes: string[];
};

const SI_NO = (valor: boolean) => (valor ? 'Sí' : 'No');

/**
 * Contenido mínimo del art. 15.1, en el MISMO ORDEN que la norma y con cada
 * dato precedido del texto que lo describe.
 */
export function declaracionResponsable(): DeclaracionResponsable {
  const productor = datosProductor();
  const fechaYLugar =
    productor.fechaDeclaracion && productor.lugarDeclaracion
      ? `${productor.fechaDeclaracion}. ${productor.lugarDeclaracion}`
      : null;

  const apartados: ApartadoDeclaracion[] = [
    {
      letra: 'a',
      descripcion: 'Nombre del sistema informático a que se refiere esta declaración responsable',
      valor: SISTEMA_INFORMATICO.nombre,
    },
    {
      letra: 'b',
      descripcion: 'Código identificador del sistema informático a que se refiere esta declaración responsable',
      valor: SISTEMA_INFORMATICO.idSistema,
    },
    {
      letra: 'c',
      descripcion:
        'Identificador completo de la versión concreta del sistema informático a que se refiere esta declaración responsable',
      valor: SISTEMA_INFORMATICO.version,
    },
    {
      letra: 'd',
      descripcion:
        'Componentes, hardware y software, de que consta el sistema informático a que se refiere esta declaración ' +
        'responsable, junto con una breve descripción de lo que hace dicho sistema informático y de sus principales funcionalidades',
      valor: `${CARACTERISTICAS_SIF.componentes} ${CARACTERISTICAS_SIF.descripcion}`,
    },
    {
      letra: 'e',
      descripcion:
        'Indicación de si el sistema informático a que se refiere esta declaración responsable se ha producido de tal ' +
        'manera que, a los efectos de cumplir con el Reglamento, solo pueda funcionar exclusivamente como «VERI*FACTU»',
      valor: SI_NO(CARACTERISTICAS_SIF.soloVerifactu),
    },
    {
      letra: 'f',
      descripcion:
        'Indicación de si el sistema informático a que se refiere esta declaración responsable permite ser usado por ' +
        'varios obligados tributarios o por un mismo usuario para dar soporte a la facturación de varios obligados tributarios',
      valor: SI_NO(CARACTERISTICAS_SIF.multiObligado),
    },
    {
      letra: 'g',
      descripcion:
        'Tipos de firma utilizados para firmar los registros de facturación y de evento en el caso de que el sistema ' +
        'informático a que se refiere esta declaración responsable no sea utilizado como «VERI*FACTU»',
      valor: CARACTERISTICAS_SIF.soloVerifactu
        ? 'No aplica: el sistema solo puede funcionar como «VERI*FACTU».'
        : CARACTERISTICAS_SIF.tiposFirma,
    },
    {
      letra: 'h',
      descripcion:
        'Nombre y apellidos de la persona o razón social de la entidad productora del sistema informático a que se refiere esta declaración responsable',
      valor: productor.nombreRazon,
    },
    {
      letra: 'i',
      descripcion:
        'Número de identificación fiscal (NIF) español de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable',
      valor: productor.nif,
    },
    {
      letra: 'j',
      descripcion:
        'Dirección postal completa de contacto de la persona o entidad productora del sistema informático a que se refiere esta declaración responsable',
      valor: productor.direccion,
    },
    {
      letra: 'k',
      descripcion:
        'La persona o entidad productora del sistema informático a que se refiere esta declaración responsable hace constar que',
      // Solo se formula el compromiso cuando hay un productor identificado que lo suscribe.
      valor:
        productor.nombreRazon && productor.nif
          ? 'dicho sistema informático, en la versión indicada en ella, cumple con lo dispuesto en el artículo 29.2.j) de la ' +
            'Ley 58/2003, de 17 de diciembre, General Tributaria, en el Reglamento que establece los requisitos que deben ' +
            'adoptar los sistemas y programas informáticos o electrónicos que soporten los procesos de facturación de ' +
            'empresarios y profesionales, y la estandarización de formatos de los registros de facturación, aprobado por el ' +
            'Real Decreto 1007/2023, de 5 de diciembre, en la Orden HAC/1177/2024, de 17 de octubre, y en la sede electrónica ' +
            'de la Agencia Estatal de Administración Tributaria para todo aquello que complete las especificaciones de dicha orden.'
          : null,
    },
    {
      letra: 'l',
      descripcion:
        'Fecha y lugar en los que la persona o entidad productora del sistema informático suscribe esta declaración responsable',
      valor: fechaYLugar,
    },
  ];

  const pendientes = apartados.filter((a) => !a.valor).map((a) => `${a.letra}) ${a.descripcion}`);
  return { titulo: TITULO_DECLARACION, apartados, completa: pendientes.length === 0, pendientes };
}

/** Ruta, dentro del propio sistema, donde se consulta la declaración. */
export const RUTA_DECLARACION = '/declaracion-responsable';

/**
 * Líneas para el pie de facturas y tickets: qué sistema ha expedido el
 * documento y dónde está su declaración responsable.
 */
export function mencionSif(baseUrl = process.env.BASE_URL): string[] {
  const productor = datosProductor();
  const sistema = `${SISTEMA_INFORMATICO.nombre} (${SISTEMA_INFORMATICO.idSistema}), versión ${SISTEMA_INFORMATICO.version}`;
  const url = baseUrl ? `${baseUrl.replace(/\/+$/, '')}${RUTA_DECLARACION}` : RUTA_DECLARACION;

  return [
    `Documento expedido con el sistema informático de facturación ${sistema}` +
      (productor.nombreRazon && productor.nif ? `, producido por ${productor.nombreRazon} (NIF ${productor.nif}).` : '.'),
    `Declaración responsable del sistema informático de facturación: ${url}`,
  ];
}
