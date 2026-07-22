"use client";

import { usePathname } from "next/navigation";
import { getElementForPath, ELEMENT_GLOW, DEFAULT_GLOW } from "@/lib/elements";

// Glow radial arriba del área de contenido, detrás del Topbar (que es
// translúcido con blur, así que se ve a través). Mismo criterio de color
// por elemento que el glow de la Sidebar, y también solo en dark mode.
export default function TopGlow() {
  const pathname = usePathname();
  const glowColor = ELEMENT_GLOW[getElementForPath(pathname) as keyof typeof ELEMENT_GLOW] ?? DEFAULT_GLOW;

  return (
    <div
      key={glowColor}
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 -z-10 hidden h-200 opacity-0 transition-opacity duration-500 dark:block dark:opacity-100"
      style={{
        // La causa real del corte duro: un radial-gradient() sin "in <space>" explícito
        // interpola en oklab por default en navegadores modernos, y desvanecer HACIA el
        // keyword "transparent" en un espacio perceptual (oklab/oklch/lab/lch) es un bug
        // conocido de la spec — el motor no sabe hacia qué matiz interpolar en alfa=0, así
        // que el tramo final se ve turbio y cae de golpe en vez de desvanecerse. Forzar
        // "in srgb" (interpolación clásica, canal por canal) arregla el fundido. La altura
        // del contenedor (800px) tiene que ser MAYOR al radio del círculo (700px) — si no,
        // el propio div corta la cola del degradado antes de llegar a 0, tronchado por el
        // overflow-hidden del padre en vez de desvanecerse del todo.
        backgroundImage: `radial-gradient(700px circle at 88% 0% in srgb, color-mix(in oklab, ${glowColor} 55%, transparent), transparent)`,
      }}
    />
  );
}
