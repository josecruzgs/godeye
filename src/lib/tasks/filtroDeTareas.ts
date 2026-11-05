import { allowedOwnerFilter, requestedOwnerFilter } from "@/lib/auth/dal";
import type { SessionUser } from "@/lib/auth/dal";
import { escapeRegex } from "@/lib/regex";

/** Los filtros de la tabla de /tasks, tal como los manda la interfaz. */
export type FiltrosDeTareas = {
  status?: string | null;
  type?: string | null;
  profileId?: string | null;
  ownerId?: string | null;
  search?: string | null;
};

/**
 * El filtro de Mongo para los filtros de la tabla, ya acotado a lo que el
 * usuario puede ver.
 *
 * Lo comparten el listado y las acciones masivas. "Seleccionar todas las que
 * coinciden" tiene que afectar exactamente a las filas que la tabla está
 * contando; con dos copias del filtro, la primera diferencia entre ellas
 * borraría tareas que el usuario nunca vio.
 */
export function filtroDeTareas(user: SessionUser, f: FiltrosDeTareas): Record<string, unknown> {
  // El admin ve las tareas de todos los operadores; el operador, las suyas.
  // El `ownerId` es el filtro opcional de la interfaz —"ver solo las de
  // fulano"— y solo se le hace caso al admin.
  const filter: Record<string, unknown> = {
    ...allowedOwnerFilter(user),
    ...requestedOwnerFilter(user, f.ownerId),
  };
  if (f.status) filter.status = f.status;
  if (f.type) filter.type = f.type;
  if (f.profileId) filter.profileId = f.profileId;
  const search = f.search?.trim();
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };
  return filter;
}
