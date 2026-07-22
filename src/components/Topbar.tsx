"use client";

import { useEffect, useState } from "react";
import { Circle } from "lucide-react";
import ThemeToggle from "./ThemeToggle";

type Status = { online: boolean } | null;

export default function Topbar() {
  const [status, setStatus] = useState<Status>(null);

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
    const interval = setInterval(check, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return (
    <header className="sticky top-0 z-10 flex items-center justify-end gap-3 border-b border-hairline bg-surface/40 px-6 py-3.5 backdrop-blur">
      {status && (
        <span
          title={status.online ? "El worker está corriendo y procesando tareas" : "El worker no está corriendo — las tareas 'queued' no avanzarán"}
          className="flex items-center gap-1.5 rounded-full border border-hairline px-2.5 py-1 text-xs font-medium text-ink-secondary"
        >
          <Circle className={`h-2 w-2 fill-current ${status.online ? "text-success" : "text-critical"}`} />
          Worker {status.online ? "activo" : "inactivo"}
        </span>
      )}
      <ThemeToggle />
    </header>
  );
}
