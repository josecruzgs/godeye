const CONFIG: Record<string, { dot: string; text: string; bg: string }> = {
  pending: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  queued: { dot: "bg-primary", text: "text-primary", bg: "bg-primary/10" },
  running: { dot: "bg-warning", text: "text-warning", bg: "bg-warning/10" },
  paused: { dot: "bg-serious", text: "text-serious", bg: "bg-serious/10" },
  success: { dot: "bg-success", text: "text-success", bg: "bg-success/10" },
  failed: { dot: "bg-critical", text: "text-critical", bg: "bg-critical/10" },
  partial: { dot: "bg-serious", text: "text-serious", bg: "bg-serious/10" },
  empty: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  cancelled: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  active: { dot: "bg-success", text: "text-success", bg: "bg-success/10" },
  inactive: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
  unknown: { dot: "bg-ink-muted", text: "text-ink-secondary", bg: "bg-page" },
};

export default function StatusBadge({ status }: { status: string }) {
  const c = CONFIG[status] ?? CONFIG.unknown;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${c.bg} ${c.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {status}
    </span>
  );
}
