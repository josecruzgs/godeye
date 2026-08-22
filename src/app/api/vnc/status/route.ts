import { NextResponse } from "next/server";
import { withAdmin } from "@/lib/apiHandler";
import { VNC_PROBE_URL } from "@/lib/vnc";

const TIMEOUT_MS = 3000;

/**
 * ¿Está viva la pantalla remota?
 *
 * Un iframe que no carga se ve igual que un escritorio en negro, y la pregunta
 * "¿se cayó AdsPower o se cayó el visor?" es justo la que uno trae al abrir
 * esta pantalla. El servidor le pega al websockify de su propio loopback y
 * traduce el error a algo accionable.
 */
export const GET = withAdmin(async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // GET y no HEAD: websockify sirve archivos estáticos y no todas las
    // versiones contestan HEAD.
    const res = await fetch(`${VNC_PROBE_URL}/vnc.html`, {
      signal: controller.signal,
      cache: "no-store",
    });
    return NextResponse.json({
      ok: res.ok,
      detail: res.ok ? null : `El visor contestó ${res.status}`,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return NextResponse.json({
      ok: false,
      detail: aborted
        ? "El visor no contestó a tiempo"
        : "No hay nadie escuchando: websockify o x11vnc están caídos",
    });
  } finally {
    clearTimeout(timer);
  }
});
