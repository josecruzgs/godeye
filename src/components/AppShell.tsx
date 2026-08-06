"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import TopGlow from "@/components/TopGlow";
import RouteTransitionOverlay from "@/components/RouteTransitionOverlay";
import Splash from "@/components/ui/Splash";
import { getElementForPath, ELEMENT_ACCENT_CLASS } from "@/lib/elements";

// Rutas sin sidebar/topbar internos: /share/[token] es la vista pública de
// un dashboard de campañas, y /login es la pantalla de contraseña del gate
// (ver src/middleware.ts) — ninguna de las dos debe verse como el panel
// interno.
const PUBLIC_PREFIXES = ["/share/", "/login"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicRoute = PUBLIC_PREFIXES.some((prefix) => pathname?.startsWith(prefix));
  const element = getElementForPath(pathname ?? "");
  // Reasigna --primary al color del elemento para toda la página: botones,
  // focos y enlaces del módulo se tiñen sin tocarlos uno por uno.
  const accentClass = element ? ELEMENT_ACCENT_CLASS[element] : "";

  if (isPublicRoute) {
    // flex-1 es necesario: <body> es un contenedor flex (fila), así que sin
    // esto <main> se encoge a su contenido en vez de ocupar el ancho
    // disponible, y el mx-auto de adentro no tiene espacio para centrar.
    // h-screen + overflow-y-auto es necesario porque <body> tiene
    // overflow-hidden (layout.tsx): sin un contenedor con altura acotada que
    // scrollee internamente, cualquier contenido más alto que el viewport
    // queda cortado sin forma de hacer scroll (el bug reportado en celulares).
    return <main className="relative h-screen flex-1 overflow-y-auto">{children}</main>;
  }

  return (
    <>
      <Splash />
      <Sidebar />
      <div className={`relative flex h-screen flex-1 flex-col overflow-hidden ${accentClass}`}>
        <TopGlow />
        <Topbar />
        <main className="relative flex-1 overflow-y-auto">
          {/* key por ruta: reinicia la animación de entrada en cada
              navegación, igual que la sala repinta la vista al cambiar de
              elemento. */}
          <div key={pathname} className="animate-rise mx-auto w-full max-w-340 px-6 pb-16 pt-6">
            {children}
          </div>
          <RouteTransitionOverlay />
        </main>
      </div>
    </>
  );
}
