import type { Metadata } from "next";
import { redirect } from "next/navigation";
import VncViewer from "@/components/VncViewer";
import { currentUser, isAdmin } from "@/lib/auth/dal";
import { VNC_VIEWER_URL } from "@/lib/vnc";
import { BRAND_NAME } from "@/lib/brand";

export const metadata: Metadata = {
  title: `Pantalla de AdsPower · ${BRAND_NAME}`,
};

/**
 * La ventana al escritorio del VPS. Se abre en una pestaña aparte desde la
 * barra superior: mirar cómo AdsPower ejecuta una tarea pide toda la pantalla,
 * y además conviene poder dejarla abierta mientras se sigue trabajando en el
 * panel.
 *
 * El rol se vuelve a chequear acá, y no solo al pintar el botón: la URL se
 * puede escribir a mano. nginx hace el mismo chequeo por su cuenta antes de
 * dejar pasar el iframe (ver /api/vnc/auth).
 */
export default async function VncPage() {
  const user = await currentUser();
  if (!user || !isAdmin(user)) redirect("/");

  return <VncViewer src={VNC_VIEWER_URL} />;
}
