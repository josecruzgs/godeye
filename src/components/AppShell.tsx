"use client";

import { usePathname } from "next/navigation";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import TopGlow from "@/components/TopGlow";
import RouteTransitionOverlay from "@/components/RouteTransitionOverlay";

// Rutas pensadas para compartirse fuera de la app (sin sidebar/topbar
// internos): /share/[token] es la vista pública de un dashboard de
// campañas.
const PUBLIC_PREFIXES = ["/share/"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isPublicRoute = PUBLIC_PREFIXES.some((prefix) => pathname?.startsWith(prefix));

  if (isPublicRoute) {
    return <main className="relative min-h-screen">{children}</main>;
  }

  return (
    <>
      <Sidebar />
      <div className="relative flex h-screen flex-1 flex-col overflow-hidden">
        <TopGlow />
        <Topbar />
        <main className="relative flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-7xl px-6 py-8">{children}</div>
          <RouteTransitionOverlay />
        </main>
      </div>
    </>
  );
}
