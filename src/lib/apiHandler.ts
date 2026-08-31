import { NextResponse } from "next/server";
import { currentUser, isAdmin, isCliente, type SessionUser } from "@/lib/auth/dal";
import { clienteCanReadApi } from "@/lib/auth/roles";

/**
 * Error con código HTTP propio. Sirve para que un helper compartido —validar
 * permisos sobre unos perfiles, por ejemplo— corte la ejecución con el status
 * correcto sin que cada ruta tenga que repetir el chequeo y armar la respuesta.
 * `withApiErrors` lo reconoce; cualquier otro error sigue siendo un 500.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

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
      if (err instanceof HttpError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      console.error("[api]", err);
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
  };
}

/**
 * Igual que `withApiErrors`, pero además exige sesión y le pasa el usuario al
 * handler como PRIMER argumento (así los de Next —`req`, `ctx`— quedan atrás y
 * TypeScript los sigue infiriendo solo):
 *
 *     export const GET = withAuth(async (user, req: NextRequest) => { ... });
 *
 * Toda ruta bajo /api que no sea pública tiene que pasar por acá. El redirect
 * de proxy.ts es solo una comodidad para el navegador: no protege nada por sí
 * mismo, porque un cliente que no siga redirects llegaría igual al handler.
 */
export function withAuth<Args extends unknown[]>(
  handler: (user: SessionUser, ...args: Args) => Promise<NextResponse>,
) {
  return withApiErrors(async (...args: Args): Promise<NextResponse> => {
    const user = await currentUser();
    if (!user) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    // Acá está el candado del rol cliente, y está acá y no en cada ruta a
    // propósito: toda la API pasa por `withAuth`, así que una ruta nueva nace
    // cerrada para él sin que nadie tenga que acordarse de cerrarla.
    //
    // El rol sale de `currentUser()`, que lo relee de Mongo en cada request —el
    // de la cookie que mira el proxy puede estar viejo, este no.
    //
    // `args[0]` es siempre el Request: Next se lo pasa al handler aunque el
    // handler no lo declare, así que se puede leer método y ruta sin obligar a
    // ninguna ruta a cambiar su firma.
    if (isCliente(user)) {
      const req = args[0] instanceof Request ? args[0] : null;
      const denied = !req || req.method !== "GET" || !clienteCanReadApi(new URL(req.url).pathname);
      if (denied) {
        return NextResponse.json({ error: "No autorizado" }, { status: 403 });
      }
    }

    return handler(user, ...args);
  });
}

/** Como `withAuth`, y además exige rol admin. */
export function withAdmin<Args extends unknown[]>(
  handler: (user: SessionUser, ...args: Args) => Promise<NextResponse>,
) {
  return withAuth(async (user: SessionUser, ...args: Args): Promise<NextResponse> => {
    if (!isAdmin(user)) {
      return NextResponse.json({ error: "Requiere rol de administrador" }, { status: 403 });
    }
    return handler(user, ...args);
  });
}
