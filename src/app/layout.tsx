import type { Metadata } from "next";
import { Space_Grotesk, Inter, JetBrains_Mono } from "next/font/google";
import ThemeScript from "@/components/ThemeScript";
import AppShell from "@/components/AppShell";
import { currentUser } from "@/lib/auth/dal";
import { SessionProvider, type ClientSession } from "@/lib/session";
import { accentStyle } from "@/lib/theme";
import { BRAND_LOGO, BRAND_NAME } from "@/lib/brand";
import "./globals.css";

// Tres familias con roles fijos, en registro técnico: Space Grotesk (display)
// para titulares, Inter para UI y cuerpo, JetBrains Mono para etiquetas de
// instrumento y cifras.
const display = Space_Grotesk({
  variable: "--font-space",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const mono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: BRAND_NAME,
  description: "Panel para automatizar cuentas de redes sociales",
  // Apunta directo al logo de lib/brand.ts en vez de mantener una copia en
  // src/app/icon.png: así el favicon nunca se puede desincronizar del logo.
  icons: { icon: BRAND_LOGO },
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
      className={`${inter.variable} ${display.variable} ${mono.variable} h-full antialiased`}
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
