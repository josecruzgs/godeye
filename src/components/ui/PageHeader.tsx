import type { ReactNode } from "react";

/**
 * Encabezado de vista: cuadro de ícono tintado, título en Fraunces y una
 * línea mono de contexto, todo sobre una regla que separa del contenido.
 * Es el mismo bloque con el que la sala abre cada módulo.
 */
export default function PageHeader({
  title,
  subtitle,
  icon,
  accent = "var(--gold)",
  right,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  accent?: string;
  right?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-center gap-3 border-b border-hairline pb-4">
      {icon && (
        <span
          className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border"
          style={{
            color: accent,
            borderColor: `color-mix(in srgb, ${accent} 55%, transparent)`,
            background: `color-mix(in srgb, ${accent} 12%, transparent)`,
          }}
        >
          {icon}
        </span>
      )}
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
        {subtitle && <p className="label-mono-sm mt-1">{subtitle}</p>}
      </div>
      {right && <div className="ml-auto flex flex-wrap items-center gap-2">{right}</div>}
    </header>
  );
}
