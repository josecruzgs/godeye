import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/dal";
import { CLIENTE_HOME, isClienteRole } from "@/lib/auth/roles";

/**
 * Quién entra a Encuestas. Ya no hay login propio: es la sesión de godeye.
 *
 * Admin y operador hacen todo lo que en el sistema original hacía ADMIN: llamar, mandar la encuesta a un número, subir
 * la base y editar el guion. Es la gente que opera el panel; llamar cuesta dinero y suena el teléfono de una persona de
 * verdad, y por eso sigue cerrado para quien solo mira.
 *
 * El cliente de godeye no llega: su única página es /campanas (proxy.ts ya lo devuelve allá).
 */
export type SesionEncuestas = { id: string; nombre: string; admin: boolean };

export async function requireSesion(): Promise<SesionEncuestas> {
  const user = await currentUser();
  if (!user) redirect("/login?next=/encuestas");
  if (isClienteRole(user.role)) redirect(CLIENTE_HOME);
  // `admin` aquí quiere decir «puede operar Encuestas», no el rol de godeye.
  return { id: user.id, nombre: user.username, admin: user.role === "admin" || user.role === "operador" };
}

export async function requireAdmin(): Promise<SesionEncuestas> {
  const s = await requireSesion();
  if (!s.admin) redirect("/encuestas?error=" + encodeURIComponent("Esa acción solo la puede hacer un administrador u operador."));
  return s;
}
