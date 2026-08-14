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
 * Cifra de cabecera del panel: la tarjeta se pinta entera con el acento, con
 * el ícono en grande y translúcido saliéndose por la esquina, etiqueta mono
 * en versalitas y número tabular que cuenta al montarse.
 *
 * La legibilidad de la tinta blanca no se resuelve acá sino en `.kpi-solid`
 * (globals.css), que normaliza la luminosidad del acento antes de pintarlo.
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
  const className = `kpi-solid c${col} relative flex min-h-26 flex-col px-4.5 py-4 ${href ? "kpi-lift" : ""}`;

  const content = (
    <>
      {/* Trazo fino y tamaño grande: el ícono es textura de fondo, no dato. */}
      {Icon && <Icon aria-hidden className="kpi-glyph" strokeWidth={1.25} />}
      <div className="kpi-label flex items-center gap-1.5">
        <span className="truncate">{label}</span>
        {live && <span className="dot-live shrink-0" style={{ background: "currentColor" }} />}
      </div>
      <div className="mt-2.5 flex flex-wrap items-baseline gap-2">
        <span className="kpi-number">
          <Num t={value} />
        </span>
      </div>
      {delta && (
        <div className="mt-2">
          <span className={`kpi-delta ${delta.positive ? "" : "is-down"}`}>
            {delta.positive ? "▲" : "▼"} {delta.text}
          </span>
        </div>
      )}
    </>
  );

  if (href) {
    return (
      <Link href={href} className={className} style={{ ["--kpi-c" as string]: c }}>
        {content}
      </Link>
    );
  }

  return (
    <div className={className} style={{ ["--kpi-c" as string]: c }}>
      {content}
    </div>
  );
}
