import { cache } from "react";
import { cookies } from "next/headers";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/mongodb";
import UserModel, { EMPTY_PREFERENCES, type Preferences, type UserRole } from "@/lib/models/User";
import { SESSION_COOKIE, readSessionToken } from "./session";

// Capa de acceso a datos, según recomienda la guía de autenticación de Next:
// proxy.ts solo hace el chequeo optimista para redirigir al login, y la
// autorización de verdad se resuelve acá, lo más cerca posible de los datos.

export type SessionUser = {
  id: string;
  objectId: Types.ObjectId;
  username: string;
  role: UserRole;
  /** group_id de AdsPower permitidos. Vacío para el admin, que los ve todos. */
  groupIds: string[];
  /** Apariencia y hora local. Nunca null: sin nada elegido va todo vacío. */
  preferences: Preferences;
};

type UserRow = {
  _id: Types.ObjectId;
  username: string;
  role: UserRole;
  groupIds?: string[];
  active?: boolean;
  preferences?: Partial<Preferences>;
};

/**
 * Usuario de la request, o null si no hay sesión válida.
 *
 * Memoizado con `cache` de React: dentro de una misma request se puede llamar
 * las veces que haga falta sin repetir la consulta a Mongo.
 *
 * Se relee el usuario en cada request a propósito, en vez de confiar en lo que
 * diga la cookie: así quitarle un grupo o darlo de baja surte efecto de
 * inmediato y no cuando le venza la sesión treinta días después.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await readSessionToken(token);
  if (!session) return null;

  if (!Types.ObjectId.isValid(session.userId)) return null;

  await dbConnect();
  const user = (await UserModel.findById(session.userId)
    .select("username role groupIds active preferences")
    .lean()) as UserRow | null;

  if (!user || user.active === false) return null;

  return {
    id: String(user._id),
    objectId: user._id,
    username: user.username,
    role: user.role,
    groupIds: user.groupIds ?? [],
    preferences: { ...EMPTY_PREFERENCES, ...(user.preferences ?? {}) },
  };
});

export function isAdmin(user: SessionUser): boolean {
  return user.role === "admin";
}

/**
 * El rol de solo lectura. Ve el resumen de campañas de todo el sistema y la
 * escucha, y no puede escribir nada: el candado vive en `withAuth`, que le
 * rechaza cualquier método que no sea GET y cualquier ruta fuera de la lista de
 * src/lib/auth/roles.ts.
 */
export function isCliente(user: SessionUser): boolean {
  return user.role === "cliente";
}

/**
 * Filtro de Mongo que recorta una colección con campo `groupId` a los grupos
 * permitidos. Para el admin no filtra nada; para un operador sin grupos
 * asignados no matchea nada, que es lo correcto.
 */
export function allowedGroupFilter(user: SessionUser): Record<string, unknown> {
  if (isAdmin(user)) return {};
  return { groupId: { $in: user.groupIds } };
}

/**
 * Lo mismo, para la colección Group, donde el id de AdsPower vive en
 * `adsPowerGroupId` en vez de en `groupId`.
 */
export function allowedGroupIdFilter(user: SessionUser): Record<string, unknown> {
  if (isAdmin(user)) return {};
  return { adsPowerGroupId: { $in: user.groupIds } };
}

export function canUseGroup(user: SessionUser, groupId: string | undefined | null): boolean {
  if (isAdmin(user)) return true;
  if (!groupId) return false;
  return user.groupIds.includes(groupId);
}

/** Filtro de propiedad para las colecciones con `ownerId`: solo lo propio. */
export function ownerFilter(user: SessionUser): { ownerId: Types.ObjectId } {
  return { ownerId: user.objectId };
}

/**
 * Alcance de lectura y edición sobre tareas y campañas.
 *
 * El admin las ve y las toca todas, sean de quien sean: es quien supervisa a
 * los operadores y necesita poder entrar a una campaña ajena a relanzar lo que
 * falló o a pausarla. Un operador sigue viendo únicamente lo suyo, igual que
 * antes.
 *
 * `ownerFilter` no desaparece: sigue siendo el filtro correcto donde "lo mío"
 * es lo que se quiere decir, como al crear.
 */
export function allowedOwnerFilter(user: SessionUser): Record<string, unknown> {
  // El cliente mira el sistema entero igual que el admin, pero solo mira: no
  // hay ninguna ruta de escritura a la que pueda llegar con este filtro puesto,
  // porque `withAuth` ya lo frenó antes por método.
  if (isAdmin(user) || isCliente(user)) return {};
  return { ownerId: user.objectId };
}

/**
 * Alcance de lectura para lo que todavía es estrictamente de cada quien.
 *
 * La escucha se sigue guardando por dueño y nadie la comparte: un operador ve
 * sus proyectos y el admin los suyos, como siempre. El cliente es la excepción,
 * porque su razón de existir es mirar el trabajo de la casa entera y con el
 * filtro de dueño puesto no vería un solo proyecto —no es dueño de ninguno.
 *
 * Se mantiene separado de `allowedOwnerFilter` a propósito: aquel abre también
 * para el admin, y ampliarle la escucha al admin de paso sería un cambio de
 * comportamiento que nadie pidió.
 */
export function readOnlyWideFilter(user: SessionUser): Record<string, unknown> {
  if (isCliente(user)) return {};
  return { ownerId: user.objectId };
}

/**
 * El `ownerId` por el que filtrar cuando la interfaz pide ver a un operador en
 * concreto. Solo el admin puede pedirlo; a un operador se le ignora, porque
 * dejárselo poner sería pisar el filtro que lo acota a lo suyo.
 */
export function requestedOwnerFilter(user: SessionUser, ownerId: string | null | undefined) {
  if (!isAdmin(user) || !ownerId || !Types.ObjectId.isValid(ownerId)) return {};
  return { ownerId: new Types.ObjectId(ownerId) };
}
