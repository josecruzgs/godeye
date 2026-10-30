import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/dal";
import { CLIENTE_HOME, isClienteRole } from "@/lib/auth/roles";

/**
 * Quién entra a Encuestas. Ya no hay login propio: es la sesión de godeye.
 *
 * El admin hace todo lo que en el sistema original hacía ADMIN: llamar, subir la base y editar el guion. El operador
 * entra a mirar el tablero y los resultados, como el CLIENTE de allá. Llamar cuesta dinero y suena el teléfono de una
 * persona de verdad, así que no se le abre a cualquiera que tenga cuenta.
 *
 * El cliente de godeye no llega: su única página es /campanas (proxy.ts ya lo devuelve allá).
 */
export type SesionEncuestas = { id: string; nombre: string; admin: boolean };

export async function requireSesion(): Promise<SesionEncuestas> {
  const user = await currentUser();
  if (!user) redirect("/login?next=/encuestas");
  if (isClienteRole(user.role)) redirect(CLIENTE_HOME);
  return { id: user.id, nombre: user.username, admin: user.role === "admin" };
}

export async function requireAdmin(): Promise<SesionEncuestas> {
  const s = await requireSesion();
  if (!s.admin) redirect("/encuestas?error=" + encodeURIComponent("Esa acción solo la puede hacer un administrador."));
  return s;
}
