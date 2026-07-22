import { NextResponse } from "next/server";

/**
 * Envuelve un route handler para que cualquier error (AdsPower caído,
 * rate-limit, Mongo, etc.) siempre termine en una respuesta JSON válida
 * en vez de que Next.js devuelva su página de error HTML por defecto
 * (que rompe `res.json()` en el cliente).
 */
export function withApiErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<NextResponse>,
) {
  return async (...args: Args): Promise<NextResponse> => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error("[api]", err);
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}
