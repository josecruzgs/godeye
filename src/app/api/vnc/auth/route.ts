import { NextResponse } from "next/server";
import { currentUser, isAdmin } from "@/lib/auth/dal";

/**
 * Portero de la pantalla remota, para el `auth_request` de nginx.
 *
 * nginx no sabe leer la cookie de sesión, así que antes de dejar pasar cada
 * petición a `/novnc/` —el HTML, los assets y también el websocket— le pregunta
 * acá. 2xx abre, 401/403 cierra. Sin esto, publicar noVNC en el dominio sería
 * dejarle a cualquiera un escritorio con las sesiones de todas las cuentas
 * abiertas.
 *
 * Solo admin: desde esa pantalla se toca AdsPower entero, no un perfil.
 *
 * Respuestas sin cuerpo: nginx descarta el body de la subpetición y esto se
 * ejecuta una vez por archivo cargado.
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  if (!isAdmin(user)) return new NextResponse(null, { status: 403 });
  return new NextResponse(null, { status: 204 });
}
