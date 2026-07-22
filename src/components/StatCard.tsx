import Link from "next/link";
import { ArrowUpRight, ArrowDownRight, type LucideIcon } from "lucide-react";

export type StatAccent = "primary" | "warning" | "series-3" | "series-5" | "success";

// Clases completas y literales a propósito (no interpoladas): el scanner de
// Tailwind necesita verlas escritas tal cual en el código para generarlas.
const ACCENT_CLASSES: Record<StatAccent, { badge: string; border: string }> = {
  primary: { badge: "bg-primary text-white", border: "border-l-primary" },
  warning: { badge: "bg-warning text-white", border: "border-l-warning" },
  "series-3": { badge: "bg-series-3 text-white", border: "border-l-series-3" },
  "series-5": { badge: "bg-series-5 text-white", border: "border-l-series-5" },
  success: { badge: "bg-success text-white", border: "border-l-success" },
};

export default function StatCard({
  label,
  value,
  href,
  icon: Icon,
  accent = "primary",
  delta,
}: {
  label: string;
  value: string | number;
  href?: string;
  icon?: LucideIcon;
  accent?: StatAccent;
  delta?: { text: string; positive: boolean };
}) {
  const { badge, border } = ACCENT_CLASSES[accent];
  const className = `group flex flex-col rounded-2xl border border-hairline ${border} border-l-4 bg-surface p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md`;

  const content = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-secondary">{label}</p>
        {Icon && (
          <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${badge}`}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-2">
        <p className="text-3xl font-semibold tracking-tight text-ink">{value}</p>
        {delta && (
          <span
            className={`mb-1 flex items-center gap-0.5 text-xs font-medium ${
              delta.positive ? "text-success" : "text-critical"
            }`}
          >
            {delta.positive ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
            {delta.text}
          </span>
        )}
      </div>
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className}>
        {content}
      </Link>
    );
  }

  return <div className={className}>{content}</div>;
}
