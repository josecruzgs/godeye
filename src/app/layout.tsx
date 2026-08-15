import type { Metadata } from "next";
import { Fraunces, Inter, IBM_Plex_Mono } from "next/font/google";
import ThemeScript from "@/components/ThemeScript";
import AppShell from "@/components/AppShell";
import { currentUser } from "@/lib/auth/dal";
import { SessionProvider, type ClientSession } from "@/lib/session";
import { accentStyle } from "@/lib/theme";
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
  title: "Julieta Ramirez · Yo con Julieta",
  description: "Panel para automatizar cuentas de redes sociales",
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // La sesión se resuelve acá arriba y baja por contexto: es lo que permite que
  // el acento, la foto y los textos del menú ya vengan bien en la primera
  // pintura, en vez de aparecer por defecto y corregirse un instante después.
  // En /login y /share no hay usuario y todo cae en los valores de la casa.
  const user = await currentUser();
  const session: ClientSession | null = user
    ? {
        id: user.id,
        username: user.username,
        role: user.role,
        groupIds: user.groupIds,
        preferences: user.preferences,
      }
    : null;

  return (
    <html
      lang="es"
      style={accentStyle(session?.preferences.accentColor)}
      className={`${inter.variable} ${fraunces.variable} ${plexMono.variable} h-full antialiased`}
      // ThemeScript toggles the "dark" class on this element before React
      // hydrates (to avoid a flash of the wrong theme); that intentional,
      // out-of-band mutation is exactly what this flag exists to allow.
      suppressHydrationWarning
    >
      <body className="relative flex min-h-full overflow-hidden bg-page text-ink">
        <ThemeScript />
        <SessionProvider value={session}>
          <AppShell>{children}</AppShell>
        </SessionProvider>
      </body>
    </html>
  );
}
