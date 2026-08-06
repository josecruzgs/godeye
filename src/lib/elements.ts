// Colores por "elemento" de sección. Los cuatro elementos son la columna
// vertebral del producto: cada módulo pertenece a uno y hereda su color, su
// ícono y su lema. Ver src/app/globals.css por los tokens --el-* detrás.
export type ElementKey = "agua" | "viento" | "tierra" | "fuego";

// Clases de Tailwind completas (no interpoladas) para que el scanner las
// detecte. "bg" es un color sólido — se combina con texto oscuro en el ícono;
// "text" se usa aparte para textos tintados (ver DisabledModule).
export const ELEMENT_ACCENTS: Record<ElementKey, { text: string; bg: string }> = {
  agua: { text: "text-agua", bg: "bg-agua" },
  viento: { text: "text-viento", bg: "bg-viento" },
  tierra: { text: "text-tierra", bg: "bg-tierra" },
  fuego: { text: "text-fuego", bg: "bg-fuego" },
};

// Color crudo (no clase Tailwind) para degradados, filos de tarjeta y glows
// radiales — se usan directo por style inline, así que necesitan el valor
// real de la variable CSS, no una clase.
export const ELEMENT_COLOR: Record<ElementKey, string> = {
  agua: "var(--el-agua)",
  viento: "var(--el-viento)",
  tierra: "var(--el-tierra)",
  fuego: "var(--el-fuego)",
};

// Alias histórico: el glow de la sidebar y el TopGlow ya lo importaban con
// este nombre.
export const ELEMENT_GLOW = ELEMENT_COLOR;

// Glow por defecto para páginas fuera de los 4 elementos (Dashboard,
// Perfiles, Grupos...). El oro es el color de la casa.
export const DEFAULT_GLOW = "var(--gold)";

// Clase de acento que reasigna --primary dentro de la página (ver
// .accent-* en globals.css): los botones, focos y enlaces de un módulo
// toman el color de su elemento sin tocar archivo por archivo.
export const ELEMENT_ACCENT_CLASS: Record<ElementKey, string> = {
  agua: "accent-agua",
  viento: "accent-viento",
  tierra: "accent-tierra",
  fuego: "accent-fuego",
};

// Nombre, rol y lema de cada elemento — el copy de la sala de inteligencia.
export const ELEMENT_META: Record<ElementKey, { name: string; title: string; lead: string }> = {
  viento: { name: "Viento", title: "Inteligencia y monitoreo", lead: "El viento todo lo observa." },
  agua: { name: "Agua", title: "Narrativa y comunicación", lead: "La marea define el cauce." },
  tierra: { name: "Tierra", title: "Operación territorial", lead: "La fuerza está en el terreno." },
  fuego: { name: "Fuego", title: "Jornada decisiva", lead: "El día decisivo." },
};

// Orden canónico de presentación (viento → agua → tierra → fuego).
export const ELEMENT_ORDER: ElementKey[] = ["viento", "agua", "tierra", "fuego"];

const ELEMENT_PATH_PREFIXES: { prefix: string; key: ElementKey }[] = [
  { prefix: "/campanas", key: "agua" },
  { prefix: "/tasks", key: "agua" },
  { prefix: "/scrapping", key: "viento" },
  { prefix: "/actividades", key: "tierra" },
  { prefix: "/dia-d", key: "fuego" },
];

// Rutas que quedan dentro de un prefijo de arriba pero en realidad viven en
// Recursos (general) — ej. Warmup se movió de Agua a Recursos mientras se
// queda en /tasks/warmup por compatibilidad de URL.
const ELEMENT_PATH_EXCLUSIONS = ["/tasks/warmup"];

// A qué elemento pertenece una ruta (para el fondo de sección), o null si la
// página no pertenece a ningún elemento (Dashboard, Perfiles, Grupos...).
export function getElementForPath(pathname: string): ElementKey | null {
  if (ELEMENT_PATH_EXCLUSIONS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return null;
  for (const { prefix, key } of ELEMENT_PATH_PREFIXES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return key;
  }
  return null;
}
