import type { LucideIcon } from "lucide-react";

// Se usa desde RouteTransitionOverlay — accentBg viene ya como clase sólida
// completa y literal (no interpolada) para que el scanner de Tailwind la
// detecte. El ícono y el anillo giratorio van en blanco: como el fondo del
// badge es un color sólido (no translúcido), un anillo del mismo tono se
// perdería contra el fondo.
export default function RouteLoading({
  icon: Icon,
  accentBg,
  label = "Cargando",
}: {
  icon: LucideIcon;
  accentBg: string;
  label?: string;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="animate-fade-in-up flex flex-col items-center gap-4">
        <span className={`relative flex h-16 w-16 items-center justify-center rounded-2xl ${accentBg} text-white`}>
          <Icon className="h-8 w-8" />
          <span className="absolute inset-0 animate-spin rounded-2xl border-2 border-white/25 border-t-white" />
        </span>
        <p className="text-sm font-medium text-ink-muted">{label}...</p>
      </div>
    </div>
  );
}
