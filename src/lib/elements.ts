// Colores por "elemento" de sección del sidebar. Los valores son clases de
// Tailwind completas (no interpoladas) para que el scanner de Tailwind las
// detecte — ver src/app/globals.css por los tokens --color-* detrás.
export type ElementKey = "agua" | "viento" | "tierra" | "fuego";

// "bg" es un color sólido (no translúcido) — se combina con texto blanco en
// el ícono; "text" se usa aparte para textos tintados (ver DisabledModule).
export const ELEMENT_ACCENTS: Record<ElementKey, { text: string; bg: string }> = {
  agua: { text: "text-primary", bg: "bg-primary" },
  viento: { text: "text-series-1", bg: "bg-series-1" },
  tierra: { text: "text-series-6", bg: "bg-series-6" },
  fuego: { text: "text-critical", bg: "bg-critical" },
};

// Color crudo (no clase Tailwind) para el glow radial de la sidebar — se usa
// directo en un radial-gradient() por style inline, así que necesita el
// valor real de la variable CSS, no una clase.
export const ELEMENT_GLOW: Record<ElementKey, string> = {
  agua: "var(--agua)",
  viento: "var(--series-1)",
  tierra: "var(--series-6)",
  fuego: "var(--status-critical)",
};

// Glow por defecto para páginas fuera de los 4 elementos (Dashboard,
// Perfiles, Grupos...).
export const DEFAULT_GLOW = "var(--primary)";

export const ELEMENT_BACKGROUNDS: Record<ElementKey, string> = {
  agua: "/media/backgrounds/agua.jpg",
  viento: "/media/backgrounds/viento.jpg",
  tierra: "/media/backgrounds/tierra.jpg",
  fuego: "/media/backgrounds/fuego.jpg",
};

// Patrón de fondo para páginas que no pertenecen a ninguno de los 4
// elementos (Dashboard, Perfiles, Grupos...).
export const GENERAL_BACKGROUND = "/media/backgrounds/general.jpg";

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
