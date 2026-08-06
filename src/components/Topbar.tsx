"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";
import ElementIcon from "./ui/ElementIcon";
import { getElementForPath, ELEMENT_COLOR, ELEMENT_META } from "@/lib/elements";

type RoleStatus = { online: boolean; host?: string | null };
type Status = { online: boolean; roles?: { tasks: RoleStatus; listening: RoleStatus } } | null;

const POLL_MS = 10000;

/**
 * Los dos workers pueden vivir en máquinas distintas —la automatización donde
 * está AdsPower, la escucha en el VPS— así que el chip tiene tres estados. Uno
 * solo diría "SIN WORKER" con la escucha funcionando perfectamente.
 */
function workerChip(status: NonNullable<Status>) {
  const tasks = status.roles?.tasks.online ?? status.online;
  const listening = status.roles?.listening.online ?? status.online;

  if (tasks && listening) {
    return { label: "EN VIVO", off: false, title: "Automatización y escucha corriendo" };
  }
  if (listening) {
    return {
      label: "SOLO ESCUCHA",
      off: true,
      title: "La escucha ingiere sola, pero no hay worker de automatización: las tareas en cola no avanzarán",
    };
  }
  if (tasks) {
    return {
      label: "SOLO TAREAS",
      off: true,
      title: "La automatización corre, pero nadie está ingiriendo menciones: la escucha solo avanzará con «Buscar ahora»",
    };
  }
  return { label: "SIN WORKER", off: true, title: "No hay ningún worker corriendo" };
}

// Reloj de sala: hora local en mono, se actualiza cada segundo. Es lo que
// hace que la barra se lea como un panel en vivo y no como un encabezado.
function useClock() {
  const [now, setNow] = useState<string | null>(null);

  useEffect(() => {
    const paint = () =>
      setNow(
        new Date().toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
      );
    paint();
    const id = setInterval(paint, 1000);
    return () => clearInterval(id);
  }, []);

  // null hasta que hidrata: la hora del servidor y la del cliente no
  // coinciden nunca, así que pintarla en SSR sería un error de hidratación.
  return now;
}

export default function Topbar() {
  const [status, setStatus] = useState<Status>(null);
  const pathname = usePathname();
  const clock = useClock();

  const element = getElementForPath(pathname ?? "");
  const accent = element ? ELEMENT_COLOR[element] : "var(--gold)";
  const meta = element ? ELEMENT_META[element] : null;

  useEffect(() => {
    let cancelled = false;

    async function check() {
      try {
        const res = await fetch("/api/worker/status");
        const data = await res.json();
        if (!cancelled) setStatus(data);
      } catch {
        if (!cancelled) setStatus({ online: false });
      }
    }

    check();
    const interval = setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b border-hairline bg-page/85 px-6 py-3 backdrop-blur-xl">
      {/* Marca del elemento en curso: cuadro tintado + nombre + rol, igual
          que el encabezado de vista de la sala. En páginas generales
          (Dashboard, Perfiles…) cae al oro de la casa. */}
      <div key={element ?? "general"} className="animate-rise flex min-w-0 items-center gap-2.5">
        <span
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border"
          style={{
            color: accent,
            borderColor: `color-mix(in srgb, ${accent} 55%, transparent)`,
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
          }}
        >
          <ElementIcon name={element ?? "eye"} size={16} />
        </span>
        <div className="min-w-0">
          <p className="font-display truncate text-[15px] font-semibold leading-tight text-ink">
            {meta?.name ?? "Ojo de Dios"}
          </p>
          <p className="label-mono-sm truncate">{meta?.title ?? "Sala de inteligencia"}</p>
        </div>
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2.5">
        <span className="classchip">USO INTERNO</span>

        {clock && (
          <span className="hidden font-mono text-[11px] tabular-nums text-ink-secondary sm:inline">
            <span className="text-ink-muted">SONORA</span> {clock}
          </span>
        )}

        {status && (
          <span title={workerChip(status).title} className={`opchip ${workerChip(status).off ? "is-off" : ""}`}>
            <i />
            {workerChip(status).label}
          </span>
        )}

        <ThemeToggle />
      </div>
    </header>
  );
}
