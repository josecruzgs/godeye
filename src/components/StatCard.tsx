import Link from "next/link";
import { type LucideIcon } from "lucide-react";
import Num from "@/components/ui/Num";
import type { PanelCol } from "@/components/ui/Panel";

export type StatAccent = "primary" | "gold" | "warning" | "series-3" | "series-5" | "success" | "agua" | "viento" | "tierra" | "fuego";

// Valores CSS crudos (no clases): alimentan el degradado de la barra de
// acento y el tinte del ícono, y ambos necesitan el color real para poder
// mezclarlo con color-mix().
const ACCENT_VALUES: Record<StatAccent, string> = {
  primary: "var(--primary)",
  gold: "var(--gold)",
  warning: "var(--status-warning)",
  "series-3": "var(--series-3)",
  "series-5": "var(--series-5)",
  success: "var(--status-good)",
  agua: "var(--el-agua)",
  viento: "var(--el-viento)",
  tierra: "var(--el-tierra)",
  fuego: "var(--el-fuego)",
};

/**
 * Cifra de cabecera del panel: barra de acento a la izquierda, etiqueta mono
 * en versalitas, número tabular que cuenta al montarse y —opcional— una
 * línea de delta debajo.
 */
export default function StatCard({
  label,
  value,
  href,
  icon: Icon,
  accent = "gold",
  delta,
  live,
  col = 3,
}: {
  label: string;
  value: string | number;
  href?: string;
  icon?: LucideIcon;
  accent?: StatAccent;
  delta?: { text: string; positive: boolean };
  live?: boolean;
  /** Columnas que ocupa dentro de un `.bento`. Se ignora fuera de uno. */
  col?: PanelCol;
}) {
  const c = ACCENT_VALUES[accent];
  const className = `card-surface c${col} relative flex min-h-26 flex-col px-4.5 py-4 ${href ? "card-lift" : ""}`;

  const content = (
    <>
      <span
        aria-hidden
        className="absolute left-0 top-0 bottom-0 w-0.75"
        style={{ background: `linear-gradient(${c}, color-mix(in srgb, ${c} 40%, transparent))` }}
      />
      <div className="label-mono flex items-center gap-1.5">
        <span className="truncate">{label}</span>
        {live && <span className="dot-live shrink-0" style={{ background: c }} />}
        {Icon && <Icon className="ml-auto h-3.5 w-3.5 shrink-0 opacity-70" style={{ color: c }} />}
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-2">
        <span className="stat-value">
          <Num t={value} />
        </span>
      </div>
      {delta && (
        <div className="mt-2">
          <span
            className="pill-mono inline-block whitespace-nowrap"
            style={{
              color: delta.positive ? "var(--ok)" : "var(--danger)",
              background: `color-mix(in srgb, ${delta.positive ? "var(--ok)" : "var(--danger)"} 16%, transparent)`,
            }}
          >
            {delta.positive ? "▲" : "▼"} {delta.text}
          </span>
        </div>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className} style={{ ["--edge-c" as string]: c }}>
        {content}
      </Link>
    );
  }

  return (
    <div className={className} style={{ ["--edge-c" as string]: c }}>
      {content}
    </div>
  );
}
