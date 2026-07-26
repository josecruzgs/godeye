import { NextRequest, NextResponse } from "next/server";
import { SITE_AUTH_COOKIE, expectedSiteAuthToken } from "@/lib/siteAuth";

// Rutas que quedan fuera del gate de contraseña: el dashboard público
// compartido (/share/[token] + la API que consume) y la propia pantalla de
// login. Todo lo demás (el panel interno) exige la cookie de sesión cuando
// SITE_PASSWORD está configurada.
const PUBLIC_PREFIXES = ["/share", "/api/public", "/login", "/api/auth/login"];

function isPublicPath(pathname: string) {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const expected = await expectedSiteAuthToken();
  if (!expected) return NextResponse.next();

  const cookie = req.cookies.get(SITE_AUTH_COOKIE)?.value;
  if (cookie === expected) return NextResponse.next();

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js)$).*)"],
};
