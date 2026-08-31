import type { UserRole } from "@/lib/models/User";

/**
 * Qué puede tocar el rol "cliente".
 *
 * Es un rol de mirar: entra, ve el resumen de campañas y la escucha, y nada
 * más. No crea, no edita, no borra.
 *
 * Este archivo es la ÚNICA lista de lo que se le permite, y lo usan tres
 * lugares a la vez: `proxy.ts` para mandarlo de vuelta cuando escribe una URL
 * que no le toca, `withAuth` para contestarle 403 en la API, y el `Sidebar`
 * para no dibujarle enlaces que no va a poder abrir. Separarlos en tres listas
 * era garantizar que un día dijeran cosas distintas.
 *
 * No importa nada de Mongo ni de Node a propósito: el proxy corre antes que la
 * app y el Sidebar corre en el navegador, así que esto tiene que ser funciones
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
 * Las páginas que el cliente puede abrir.
 *
 * `/campanas` va exacto y no como prefijo: `/campanas/compartir` es el armador
 * de dashboards públicos —crea, edita y borra enlaces— y no tiene nada que
 * hacer acá.
 *
 * De la escucha se le da la lista de proyectos y el proyecto en sí, que es lo
 * que se lee. `publicaciones` queda afuera porque es desde donde se despachan
 * publicaciones: aunque el candado de solo-GET ya no lo dejaría enviar nada, es
 * una pantalla de trabajo y le mostraría el parque de perfiles entero.
 */
export function clienteCanOpenPage(pathname: string): boolean {
  if (pathname === "/campanas") return true;
  if (pathname.endsWith("/publicaciones")) return false;
  return under(pathname, "/scrapping");
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
  if (pathname === "/api/worker/status") return true;
  return under(pathname, "/api/listening") || under(pathname, "/api/auth");
}
