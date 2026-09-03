"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gauge, Lock } from "lucide-react";
import { MOTORES_TOTALES } from "@/lib/motores";

type MotorTask = {
  id: string;
  name: string;
  type: string;
  profile: string | null;
  campaignId: string | null;
  startedAt: string | null;
  visible: boolean;
};

type Motor = { engine: number; active: boolean; task: MotorTask | null };

type Respuesta = {
  online?: boolean;
  engines?: { total: number; active: number; slots: Motor[] };
};

/** Cada cuánto se le pregunta al servidor qué hay en los motores. */
const POLL_MS = 4000;

/** Segmentos de la barra. Veinte entran cómodos en la fila más angosta. */
const SEGMENTOS = 20;

const TYPE_LABELS: Record<string, string> = {
  like: "Like",
  likecomment: "Like a comentario",
  comment: "Comentario",
  post: "Publicación",
  warmup: "Warmup",
  scrape: "Scrape",
  login: "Login",
  ramificacion: "Ramificación",
  custom: "Personalizada",
};

/**
 * Cronómetro de la tarea, en el formato corto del reloj: segundos hasta el
 * minuto, y de ahí `m:ss`. Se recalcula solo, sin esperar al siguiente poll:
 * un número que salta de 4 en 4 segundos se lee como un dato viejo.
 */
function useTranscurrido(desde: string | null): string | null {
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    if (!desde) return;
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, [desde]);

  if (!desde) return null;
  const seg = Math.max(0, Math.floor((ahora - new Date(desde).getTime()) / 1000));
  if (seg < 60) return `${seg}s`;
  const min = Math.floor(seg / 60);
  if (min < 60) return `${min}:${String(seg % 60).padStart(2, "0")}`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

/**
 * Una ranura del worker.
 *
 * Los tres estados son distintos a propósito: apagado (el worker no lo
 * encendió), libre (encendido y esperando trabajo) y activo (con una tarea
 * adentro). Sin el primero, subir `WORKER_ENGINES` sería una sorpresa; con él,
 * la pantalla ya muestra a dónde puede crecer el sistema.
 */
function Fila({ motor }: { motor: Motor }) {
  const task = motor.task;
  const corriendo = Boolean(task);
  const transcurrido = useTranscurrido(task?.startedAt ?? null);

  const estado = corriendo ? "motor-activo" : motor.active ? "motor-libre" : "motor-apagado";

  const etiqueta = task
    ? (TYPE_LABELS[task.type] ?? task.type)
    : motor.active
      ? "En espera"
      : "No disponible";

  const detalle = task
    ? task.visible
      ? [task.name, task.profile].filter(Boolean).join(" · ")
      : task.name
    : motor.active
      ? "Listo para tomar la siguiente tarea de la cola"
      : "Se enciende al subir la capacidad del worker";

  const cuerpo = (
    <div className={`motor-fila ${estado} flex items-center gap-3 px-3 py-2.5`}>
      {/* Número del motor. Es la identidad de la ranura: la misma tarea se ve
          en el mismo hueco mientras dure. */}
      <span
        className="grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-hairline font-mono text-[11px] font-semibold tabular-nums"
        style={{
          color: corriendo ? "var(--gold)" : "var(--text-muted, inherit)",
          borderColor: corriendo ? "color-mix(in srgb, var(--gold) 40%, transparent)" : undefined,
          opacity: motor.active ? 1 : 0.45,
        }}
      >
        {motor.active ? motor.engine : <Lock className="h-3 w-3" aria-hidden />}
      </span>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <span
            className={`truncate text-[13px] ${corriendo ? "font-medium text-ink" : "text-ink-muted"}`}
            style={{ opacity: motor.active ? 1 : 0.6 }}
          >
            <span className="label-mono-sm mr-2">{etiqueta}</span>
            <span className="text-ink-secondary">{detalle}</span>
          </span>
          {/* El cronómetro ocupa lugar siempre, aunque esté vacío: si apareciera
              y desapareciera, el texto de la izquierda se movería en cada
              arranque y cada final de tarea. */}
          <span
            className="w-14 shrink-0 text-right font-mono text-[13px] tabular-nums"
            style={{ color: corriendo ? "var(--gold)" : "transparent" }}
          >
            {transcurrido ?? "—"}
          </span>
        </div>

        <div className={`motor-barra ${estado}`} aria-hidden>
          {Array.from({ length: SEGMENTOS }, (_, i) => (
            <span
              key={i}
              className="motor-seg"
              // El desfase por índice es lo que hace la onda. 55ms sobre 20
              // segmentos da algo más de un segundo de recorrido, por debajo
              // del ciclo de la animación: la onda entra antes de reiniciarse.
              style={corriendo ? { ["--d" as string]: `${i * 55}ms` } : undefined}
            />
          ))}
        </div>
      </div>
    </div>
  );

  // Solo se puede ir a la campaña si es del que mira; la de otro operador no
  // existe para él y el link daría un 404 o, peor, una pantalla vacía.
  return task?.campaignId ? (
    <Link href={`/campanas?campaignId=${task.campaignId}`} className="block">
      {cuerpo}
    </Link>
  ) : (
    cuerpo
  );
}

/**
 * Los motores del worker: cuántas tareas puede correr a la vez y qué hay en
 * cada una ahora mismo.
 *
 * Vive arriba de /campanas porque es la respuesta a la pregunta que se hace
 * mirando esa pantalla —"¿por qué esto no avanza más rápido?"—: con los motores
 * a la vista se ve si el sistema está saturado o simplemente ocioso.
 */
export default function Motores() {
  const [data, setData] = useState<Respuesta | null>(null);

  useEffect(() => {
    let cancelado = false;

    async function traer() {
      try {
        const res = await fetch("/api/worker/status");
        if (!res.ok) return;
        const json = (await res.json()) as Respuesta;
        if (!cancelado) setData(json);
      } catch {
        // Un poll que falla no borra lo que ya se veía: dejar la pantalla en
        // blanco por un corte de red de dos segundos es peor que un dato con
        // cuatro segundos de atraso.
      }
    }

    traer();
    const id = setInterval(traer, POLL_MS);
    return () => {
      cancelado = true;
      clearInterval(id);
    };
  }, []);

  // Mientras no llegó la primera respuesta se dibujan las ranuras apagadas, no
  // un hueco: el alto del panel no cambia cuando entra el dato.
  const slots: Motor[] =
    data?.engines?.slots ??
    Array.from({ length: MOTORES_TOTALES }, (_, i) => ({ engine: i + 1, active: false, task: null }));

  const total = data?.engines?.total ?? MOTORES_TOTALES;
  const activos = data?.engines?.active ?? 0;
  const ocupados = slots.filter((m) => m.task).length;
  const online = data?.online ?? false;

  return (
    <section
      className="card-surface px-4.5 py-4"
      style={{ ["--edge-c" as string]: "var(--gold)" }}
    >
      <header className="panel-head">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid shrink-0 place-items-center" style={{ color: "var(--gold)" }}>
            <Gauge className="h-4 w-4" aria-hidden />
          </span>
          <span className="panel-title">Motores</span>
          <span className="panel-tag">
            {activos} de {total} activos
          </span>
        </div>
        <div className="shrink-0">
          <span className="label-mono-sm">
            {!online
              ? "worker sin latido"
              : ocupados === 0
                ? "sin tareas en curso"
                : `${ocupados} en ejecución`}
          </span>
        </div>
      </header>

      <div className="flex flex-col gap-1">
        {slots.map((motor) => (
          <Fila key={motor.engine} motor={motor} />
        ))}
      </div>
    </section>
  );
}
