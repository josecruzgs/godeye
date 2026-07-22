import type { LucideIcon } from "lucide-react";
import { type ElementKey, ELEMENT_ACCENTS } from "@/lib/elements";

export default function DisabledModule({
  title,
  icon: Icon,
  element,
}: {
  title: string;
  icon: LucideIcon;
  element: ElementKey;
}) {
  const accent = ELEMENT_ACCENTS[element];

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="animate-fade-in-up flex flex-col items-center gap-4 rounded-2xl border border-hairline bg-surface/60 px-16 py-14 text-center shadow-sm backdrop-blur-xl">
        <span className={`flex h-16 w-16 items-center justify-center rounded-2xl ${accent.bg} text-white`}>
          <Icon className="h-8 w-8" />
        </span>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
          <p className={`mt-2 text-sm font-semibold uppercase tracking-wide ${accent.text}`}>Inhabilitada</p>
        </div>
      </div>
    </div>
  );
}
