/**
 * Regla de nombres de usuario, compartida por el alta y el cambio de nombre en
 * /usuarios: si cada ruta tuviera su copia, un día dejarían crear un nombre que
 * después no se puede volver a poner.
 *
 * Se guarda en minúsculas porque el login también las pasa a minúsculas antes
 * de buscar.
 */
export function normalizeUsername(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function usernameProblem(username: string): string | null {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) {
    return "El usuario debe tener entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo";
  }
  return null;
}
