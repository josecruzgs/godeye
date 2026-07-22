import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ThemeScript from "@/components/ThemeScript";
import SectionBackdrop from "@/components/SectionBackdrop";
import RouteTransitionOverlay from "@/components/RouteTransitionOverlay";
import TopGlow from "@/components/TopGlow";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Ojo de Dios — Automatización Social Media",
  description: "Panel para automatizar cuentas de redes sociales con Ojo de Dios",
  // Apunta directo a public/media/*.png en vez de mantener una copia en
  // src/app/icon.png: así el favicon nunca se puede desincronizar del logo
  // cuando se reemplacen esos archivos. logo.png es blanco (para navegador
  // en modo oscuro) y logoblack.png es negro (para modo claro) — el
  // navegador elige según la preferencia de color del sistema operativo.
  icons: {
    icon: [
      { url: "/media/logoblack.png", media: "(prefers-color-scheme: light)" },
      { url: "/media/logo.png", media: "(prefers-color-scheme: dark)" },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="es"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // ThemeScript toggles the "dark" class on this element before React
      // hydrates (to avoid a flash of the wrong theme); that intentional,
      // out-of-band mutation is exactly what this flag exists to allow.
      suppressHydrationWarning
    >
      <body className="relative flex min-h-full overflow-hidden bg-page text-ink">
        <ThemeScript />
        <SectionBackdrop />
        <Sidebar />
        <div className="relative flex h-screen flex-1 flex-col overflow-hidden">
          <TopGlow />
          <Topbar />
          <main className="relative flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-7xl px-6 py-8">{children}</div>
            <RouteTransitionOverlay />
          </main>
        </div>
      </body>
    </html>
  );
}
