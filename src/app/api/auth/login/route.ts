import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/apiHandler";
import { SITE_AUTH_COOKIE, expectedSiteAuthToken } from "@/lib/siteAuth";
import { rateLimit, rateLimitReset, clientIp } from "@/lib/rateLimit";

// Ocho intentos cada quince minutos y después media hora de espera. Alcanza de
// sobra para quien tipeó mal la contraseña y hace inviable probarla a ciegas.
const LIMIT = { limit: 8, windowMs: 15 * 60_000, blockMs: 30 * 60_000 };

/** Comparación de tiempo constante: dos textos distintos no deben tardar distinto. */
function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const POST = withApiErrors(async (req: NextRequest) => {
  const ip = clientIp(req);
  const gate = rateLimit(`login:${ip}`, LIMIT);
  if (!gate.ok) {
    return NextResponse.json(
      { error: `Demasiados intentos. Probá de nuevo en ${Math.ceil(gate.retryAfterSec / 60)} minutos.` },
      { status: 429, headers: { "Retry-After": String(gate.retryAfterSec) } },
    );
  }

  const body = await req.json();
  const password = typeof body.password === "string" ? body.password : "";

  const expected = await expectedSiteAuthToken();
  if (!expected) {
    return NextResponse.json({ error: "SITE_PASSWORD no está configurada en el servidor" }, { status: 500 });
  }
  if (!sameSecret(password, process.env.SITE_PASSWORD ?? "")) {
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }

  rateLimitReset(`login:${ip}`);

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SITE_AUTH_COOKIE, expected, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
});
