export const SITE_AUTH_COOKIE = "site_auth";

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// El valor de la cookie es el hash de SITE_PASSWORD, no la contraseña en
// texto plano — así un visitante que inspeccione sus propias cookies no ve
// la contraseña real. No hay SITE_PASSWORD seteada => el gate queda
// desactivado (comportamiento por defecto en local, donde nadie más puede
// llegar a localhost de todos modos).
export async function expectedSiteAuthToken(): Promise<string | null> {
  const password = process.env.SITE_PASSWORD;
  if (!password) return null;
  return sha256Hex(password);
}
