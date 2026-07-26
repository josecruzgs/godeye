import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/apiHandler";
import { SITE_AUTH_COOKIE, expectedSiteAuthToken } from "@/lib/siteAuth";

export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  const password = typeof body.password === "string" ? body.password : "";

  const expected = await expectedSiteAuthToken();
  if (!expected) {
    return NextResponse.json({ error: "SITE_PASSWORD no está configurada en el servidor" }, { status: 500 });
  }
  if (password !== process.env.SITE_PASSWORD) {
    return NextResponse.json({ error: "Contraseña incorrecta" }, { status: 401 });
  }

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
