"use client";

import { usePathname } from "next/navigation";
import { getElementForPath, ELEMENT_BACKGROUNDS, GENERAL_BACKGROUND } from "@/lib/elements";

export default function SectionBackdrop() {
  const pathname = usePathname();
  const element = getElementForPath(pathname);
  // Fuera de los 4 elementos (Dashboard, Perfiles, Grupos...) se usa el
  // patrón general en vez de no tener fondo.
  const backgroundUrl = element ? ELEMENT_BACKGROUNDS[element] : GENERAL_BACKGROUND;

  return (
    <div
      key={element ?? "general"}
      // El patrón trae fondo blanco. En claro eso ya combina bien con la
      // página (casi blanca) tal cual. En oscuro, pintado plano se ve como
      // un mosaico blanco pegado sobre el azul marino — bg-blend-overlay lo
      // funde con --page-plane para que las líneas queden como textura del
      // mismo color, no como un tile aparte. (overlay contra una base clara
      // lava casi todo el contraste, por eso solo se activa en dark:).
      className="animate-fade-in-up absolute inset-0 -z-10 overflow-hidden bg-page bg-repeat dark:bg-blend-overlay"
      style={{ backgroundImage: `url(${backgroundUrl})` }}
    >
      <div className="absolute inset-0 bg-page/20" />
    </div>
  );
}
