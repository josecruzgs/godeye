/**
 * La marca visible de la app, en un solo lugar.
 *
 * Antes estaba escrita a mano en ocho archivos —menú, login, cortinilla,
 * títulos de pestaña, panel público—, así que cambiarla implicaba encontrarlos
 * todos y no olvidarse de ninguno.
 */
export const BRAND_NAME = "Profiles Net";

/**
 * La marca es de una sola línea, así que por defecto no hay subtítulo.
 *
 * El campo sigue existiendo en /ajustes: quien quiera una segunda línea la
 * escribe ahí y aparece. Los componentes que la muestran la pintan solo cuando
 * tiene algo, para no dejar un renglón vacío empujando la maquetación.
 */
export const BRAND_SUBTITLE = "";
