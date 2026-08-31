import type { UserRole } from "@/lib/models/User";

// Sesión en una cookie firmada, sin estado en el servidor.
//
// El valor es `userId.expiración.firma`, donde la firma es un HMAC-SHA256 del
// resto sobre SESSION_SECRET. Nadie puede fabricarla ni estirarle el
// vencimiento sin conocer el secreto, y verificarla no cuesta una consulta a
// Mongo — importante porque proxy.ts la revisa en CADA request.
//
// Usa WebCrypto y no `node:crypto`. Desde Next 16 el proxy corre en Node y las
// dos andarían, pero WebCrypto sirve igual en los dos runtimes y este módulo lo
// importa proxy.ts: no hay motivo para atarlo a uno.

export const SESSION_COOKIE = "godeye_session";

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * El rol viaja firmado dentro de la cookie, además de estar en Mongo.
 *
 * No es para decidir permisos —eso lo sigue resolviendo `currentUser()`
 * releyendo el usuario— sino para que `proxy.ts` pueda mandar a un cliente de
 * vuelta a su página sin consultar la base. La guía de autenticación de Next es
 * explícita en esto: el proxy corre en CADA request, incluidos los prefetch de
 * cada `<Link>` que alguien pasa por encima con el mouse, así que ahí solo se
 * lee la cookie.
 *
 * El costo de tenerlo acá es que un cambio de rol no surte efecto hasta el
 * próximo login: la cookie sigue diciendo lo de antes. Solo afecta a qué
 * páginas puede PEDIR —los datos los sirve la API, que sí relee el rol— y se
 * arregla haciendo que la persona vuelva a entrar.
 */
export type SessionRole = UserRole;

export type SessionPayload = { userId: string; expiresAt: number; role: SessionRole | null };

// La lista se repite acá en vez de importar USER_ROLES porque ese módulo trae
// mongoose colgando, y este lo importa proxy.ts, que corre delante de la app en
// cada request. El `import type` de arriba sí se borra al compilar, así que el
// tipo mantiene las dos listas atadas: un rol mal escrito no compila.
const ROLES: readonly UserRole[] = ["admin", "operador", "cliente"];

// importKey es asíncrono y se llamaría en cada request; se memoiza contra el
// secreto para que rotarlo no siga usando la clave vieja.
let cachedKey: { secret: string; key: CryptoKey } | null = null;

async function hmacKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error("SESSION_SECRET no está definido. Revisa tu .env.local");
  }
  if (cachedKey?.secret === secret) return cachedKey.key;

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { secret, key };
  return key;
}

async function sign(data: string): Promise<string> {
  const signature = await globalThis.crypto.subtle.sign(
    "HMAC",
    await hmacKey(),
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparación de tiempo constante, sin depender de `node:crypto`. */
function sameSignature(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(
  userId: string,
  role: SessionRole,
  now = Date.now(),
): Promise<string> {
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${userId}.${role}.${expiresAt}`;
  return `${payload}.${await sign(payload)}`;
}

/**
 * Devuelve el payload si la firma es válida y no venció; si no, null.
 *
 * Acepta las dos formas: la de tres partes que se emitía antes de que el rol
 * entrara al token, y la de cuatro. Sin esto, publicar este cambio echaba a
 * todo el mundo de su sesión de golpe. Una cookie vieja devuelve `role: null`,
 * y el proxy la trata como "no sé qué rol es, que pase" — es correcto porque el
 * rol cliente no existía cuando esa cookie se emitió, y porque los datos los
 * sigue custodiando la API releyendo el rol de Mongo.
 */
export async function readSessionToken(
  token: string | undefined,
  now = Date.now(),
): Promise<SessionPayload | null> {
  if (!token) return null;

  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;

  const signature = parts[parts.length - 1];
  const payload = parts.slice(0, -1).join(".");
  const userId = parts[0];
  const rawExpiry = parts[parts.length - 2];
  const rawRole = parts.length === 4 ? parts[1] : null;
  if (!userId || !rawExpiry || !signature) return null;

  const expiresAt = Number(rawExpiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;

  const expected = await sign(payload);
  if (!sameSignature(signature, expected)) return null;

  const role = ROLES.find((known) => known === rawRole) ?? null;
  return { userId, expiresAt, role };
}

/** Opciones de la cookie, iguales al setearla y al borrarla. */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
} as const;
