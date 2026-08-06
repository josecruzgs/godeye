import type { Metadata } from "next";
import { Fraunces, Inter, IBM_Plex_Mono } from "next/font/google";
import ThemeScript from "@/components/ThemeScript";
import AppShell from "@/components/AppShell";
import "./globals.css";

// Tres familias con roles fijos, como la sala de inteligencia: Fraunces
// (display) para titulares, Inter para UI y cuerpo, IBM Plex Mono para
// etiquetas de instrumentación y cifras.
const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  // Fraunces es variable en dos ejes; `opsz` es el que hace que a 42px las
  // astas se afinen en vez de verse como el mismo dibujo escalado. Sin
  // pedirlo explícitamente, next/font solo trae `wght`.
  axes: ["opsz"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  // IBM Plex Mono no es variable: hay que enumerar los pesos que se usan.
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Ojo de Dios · Sala de Inteligencia",
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
      className={`${inter.variable} ${fraunces.variable} ${plexMono.variable} h-full antialiased`}
      // ThemeScript toggles the "dark" class on this element before React
      // hydrates (to avoid a flash of the wrong theme); that intentional,
      // out-of-band mutation is exactly what this flag exists to allow.
      suppressHydrationWarning
    >
      <body className="relative flex min-h-full overflow-hidden bg-page text-ink">
        <ThemeScript />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
