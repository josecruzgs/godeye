/**
 * La marca visible de la app, en un solo lugar.
 *
 * Antes estaba escrita a mano en ocho archivos —menú, login, cortinilla,
 * títulos de pestaña, panel público—, así que cambiarla implicaba encontrarlos
 * todos y no olvidarse de ninguno.
 */
export const BRAND_NAME = "Ojo de Dios";

/**
 * La marca es de una sola línea, así que por defecto no hay subtítulo.
 *
 * El campo sigue existiendo en /ajustes: quien quiera una segunda línea la
 * escribe ahí y aparece. Los componentes que la muestran la pintan solo cuando
 * tiene algo, para no dejar un renglón vacío empujando la maquetación.
 */
export const BRAND_SUBTITLE = "";

/**
 * El logo, en un solo archivo. Tiene fondo transparente y se lee igual en modo
 * claro y oscuro, así que ya no hay versión blanca y negra.
 *
 * Cambiar el logo es poner un archivo con OTRO nombre y apuntar aquí, no
 * sobrescribir este: el optimizador de imágenes de Next guarda copias por URL
 * en .next/cache, que sobrevive a los deploys, y seguía sirviendo el logo
 * anterior a algunos tamaños.
 */
export const BRAND_LOGO = "/media/ojodedios.png";
