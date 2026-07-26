const CONFIG: Record<string, { dot: string; text: string; bg: string }> = {
  pending: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  queued: { dot: "bg-primary", text: "text-primary", bg: "bg-primary/10" },
  running: { dot: "bg-warning", text: "text-warning", bg: "bg-warning/10" },
  paused: { dot: "bg-serious", text: "text-serious", bg: "bg-serious/10" },
  success: { dot: "bg-success", text: "text-success", bg: "bg-success/10" },
  failed: { dot: "bg-critical", text: "text-critical", bg: "bg-critical/10" },
  // "partial" = terminó con algunas fallidas mezcladas entre las exitosas —
  // sigue siendo un resultado mayormente bueno, así que se pinta en lime
  // (no en el naranja de "serious") y se etiqueta "Exitosa (P)" para dejar
  // claro que es una variante de éxito, no un estado de alerta.
  partial: { dot: "bg-lime-500", text: "text-lime-600 dark:text-lime-400", bg: "bg-lime-500/10" },
  empty: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  cancelled: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  active: { dot: "bg-success", text: "text-success", bg: "bg-success/10" },
  inactive: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  unknown: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
};

const LABELS: Record<string, string> = {
  pending: "Pendiente",
  queued: "En cola",
  running: "Corriendo",
  paused: "Pausada",
  success: "Exitosa",
  failed: "Fallida",
  partial: "Exitosa (P)",
  empty: "Vacía",
  cancelled: "Cancelada",
  active: "Activo",
  inactive: "Inactivo",
  unknown: "Desconocido",
};

export default function StatusBadge({ status }: { status: string }) {
  const c = CONFIG[status] ?? CONFIG.unknown;
  return (
    <span
      className={`inline-flex w-30 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${c.bg} ${c.text}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
      {LABELS[status] ?? status}
    </span>
  );
}
