import type { UserRole } from "@/lib/models/User";

/**
 * Qué puede tocar el rol "cliente".
 *
 * Es un rol de mirar: entra, cae en el resumen de campañas y ahí se queda. No
 * crea, no edita, no borra, y no tiene a dónde navegar — ni siquiera se le
 * dibuja el menú lateral (ver AppShell).
 *
 * Este archivo es la ÚNICA lista de lo que se le permite, y lo usan tres
 * lugares a la vez: `proxy.ts` para mandarlo de vuelta cuando escribe una URL
 * que no le toca, `withAuth` para contestarle 403 en la API, y `AppShell` para
 * decidir que no lleva menú. Separarlos en tres listas era garantizar que un
 * día dijeran cosas distintas.
 *
 * No importa nada de Mongo ni de Node a propósito: el proxy corre antes que la
 * app y AppShell corre en el navegador, así que esto tiene que ser funciones
 * puras y nada más.
 */

/** A dónde cae un cliente que pidió algo que no le corresponde. */
export const CLIENTE_HOME = "/campanas";

/** Cómo se llama cada rol en pantalla. Vive acá y no en el modelo porque el
 *  modelo importa mongoose y esto lo usan componentes del navegador. */
export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administrador",
  operador: "Operador",
  cliente: "Cliente",
};

export function isClienteRole(role: UserRole | null | undefined): boolean {
  return role === "cliente";
}

/** `true` si `pathname` es `prefix` o algo colgando de él. */
function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * La única página que el cliente puede abrir.
 *
 * Es una sola y va exacta, no como prefijo: `/campanas/compartir` es el armador
 * de dashboards públicos —crea, edita y borra enlaces— y no tiene nada que
 * hacer acá. Al cliente ni siquiera se le dibuja el menú lateral (ver
 * AppShell): entra, ve su resumen, y no hay a dónde navegar.
 */
export function clienteCanOpenPage(pathname: string): boolean {
  return pathname === "/campanas";
}

/**
 * Los endpoints que el cliente puede consultar. Solo de lectura: quien llame a
 * esto ya tiene que haber comprobado que el método es GET.
 *
 * `/api/campaigns` va exacto —la lista— y no como prefijo: el detalle
 * (`/api/campaigns/<id>`) trae tarea por tarea con su perfil y su error, que es
 * justamente lo que este rol no debe ver. Por eso tampoco se le abre el modal
 * en la tabla.
 */
export function clienteCanReadApi(pathname: string): boolean {
  if (pathname === "/api/campaigns") return true;
  // El chip de "EN VIVO" de la barra superior, que se pinta en toda página.
  if (pathname === "/api/worker/status") return true;
  return under(pathname, "/api/auth");
}
