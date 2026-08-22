"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RefreshCw, X } from "lucide-react";

type Health = { ok: boolean; detail: string | null } | null;

const POLL_MS = 15000;

/**
 * Visor de la pantalla virtual del VPS, a ventana completa.
 *
 * Es un iframe y no un cliente noVNC propio a propósito: el `vnc.html` que trae
 * el paquete ya resuelve teclado, portapapeles, escalado y reconexión, y
 * reimplementarlo con `@novnc/novnc` sería mantener lo mismo dos veces.
 *
 * Encima va una barra delgada con lo que el iframe no puede dar: si el visor
 * está vivo (un escritorio en negro y un websockify caído se ven idénticos),
 * un botón para reconectar sin recargar la pestaña, y pantalla completa.
 */
export default function VncViewer({ src }: { src: string }) {
  const [health, setHealth] = useState<Health>(null);
  // Cambiar la key remonta el iframe: es la forma de reconectar sin que el
  // usuario pierda la pestaña ni tenga que buscar el botón dentro de noVNC.
  const [attempt, setAttempt] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch("/api/vnc/status", { cache: "no-store" });
      setHealth(await res.json());
    } catch {
      setHealth({ ok: false, detail: "No se pudo consultar el estado del visor" });
    }
  }, []);

  useEffect(() => {
    check();
    const id = setInterval(check, POLL_MS);
    return () => clearInterval(id);
  }, [check]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void shellRef.current?.requestFullscreen();
  }

  function reconnect() {
    setAttempt((n) => n + 1);
    void check();
  }

  return (
    <div ref={shellRef} className="flex h-full flex-col bg-black">
      <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-hairline bg-page px-4 py-2">
        <div className="min-w-0">
          <p className="font-display truncate text-[14px] font-semibold leading-tight text-ink">
            Pantalla de AdsPower
          </p>
          <p className="label-mono-sm truncate">Escritorio virtual del VPS</p>
        </div>

        {health && (
          <span
            title={health.detail ?? "websockify y x11vnc responden"}
            className={`opchip ${health.ok ? "" : "is-off"}`}
          >
            <i />
            {health.ok ? "VISOR EN LÍNEA" : "VISOR CAÍDO"}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={reconnect}
            title="Reconectar"
            aria-label="Reconectar"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink-secondary transition-colors hover:text-ink"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={toggleFullscreen}
            title={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
            aria-label={fullscreen ? "Salir de pantalla completa" : "Pantalla completa"}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink-secondary transition-colors hover:text-ink"
          >
            {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => window.close()}
            title="Cerrar la pestaña"
            aria-label="Cerrar la pestaña"
            className="flex h-8 w-8 items-center justify-center rounded-full border border-hairline bg-surface text-ink-secondary transition-colors hover:text-ink"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Con el visor caído el iframe se monta igual y pinta el error del
          navegador —una página en blanco sin explicación—, así que en ese caso
          se cambia por el aviso. Mientras no se sabe (health null) se monta:
          el iframe tarda menos en conectar que la comprobación en volver. */}
      {health && !health.ok ? (
        <div className="grid flex-1 place-items-center bg-page px-6 text-center">
          <div className="max-w-md">
            <p className="font-display text-[15px] font-semibold text-ink">No hay pantalla que mostrar</p>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-secondary">{health.detail}</p>
            <p className="label-mono-sm mt-3 leading-relaxed">
              En el VPS: sudo systemctl status xvfb x11vnc novnc
            </p>
          </div>
        </div>
      ) : (
        <iframe
          key={attempt}
          src={src}
          title="Pantalla de AdsPower"
          // El portapapeles es lo que hace usable la pantalla: sin esto no se
          // puede pegar una contraseña ni copiar un error del navegador remoto.
          allow="clipboard-read; clipboard-write; fullscreen"
          className="flex-1 border-0"
        />
      )}
    </div>
  );
}
