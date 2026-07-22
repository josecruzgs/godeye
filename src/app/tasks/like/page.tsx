"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Heart, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { apiFetch } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import Card from "@/components/Card";
import Modal from "@/components/Modal";
import PlatformPicker from "@/components/PlatformPicker";
import ProfilePicker, { type PickerGroup, type PickerProfile } from "@/components/ProfilePicker";

type CreatedTask = {
  _id: string;
  name: string;
  status: string;
  profile: { _id: string; name: string };
};

// Un permalink de post de Facebook (facebook.com/.../posts/<id>/) se abre como
// un dialog superpuesto sobre el feed de fondo — no como página aislada. El
// feed de fondo sigue en el DOM (dimeado detrás) con SU PROPIA copia de los
// botones de like/reacción, así que un selector sin "div[role='dialog']" por
// delante matchea también esos duplicados de fondo y termina clickeando el
// que sea el primero en orden del DOM, no necesariamente el visible/real —
// confirmado en vivo: sin el scope, el hover fallaba por "elemento tapado"
// porque el match elegido era del feed de fondo, tapado por el propio dialog.
const PLATFORM_PRESETS: Record<string, { label: string; selector: string }> = {
  facebook: {
    label: "Facebook",
    selector: 'div[role="dialog"] div[aria-label="Like"], div[role="dialog"] div[aria-label="Me gusta"]',
  },
  instagram: { label: "Instagram", selector: 'svg[aria-label="Like"], svg[aria-label="Me gusta"]' },
  tiktok: { label: "TikTok", selector: '[data-e2e="like-icon"]' },
  x: { label: "X / Twitter", selector: '[data-testid="like"]' },
  custom: { label: "Personalizado", selector: "" },
};

// El picker de reacciones (mantener el cursor sobre "Me gusta" para que
// aparezcan las demás) es un patrón exclusivo de Facebook — las otras
// plataformas solo tienen like/no-like, así que el selector de reacción
// queda oculto fuera de Facebook. Cada aria-label trae español e inglés
// juntos (comma-list SÍ funciona como OR en selectores de atributo CSS
// planos, a diferencia del engine text= — confirmado en Publicar/Auto
// Profile este mismo proyecto).
const REACTIONS: { key: string; label: string; ariaLabels?: string[] }[] = [
  { key: "like", label: "👍 Me gusta (default)" },
  { key: "love", label: "❤️ Me encanta", ariaLabels: ["Me encanta", "Love"] },
  { key: "care", label: "🤗 Me importa", ariaLabels: ["Me importa", "Care"] },
  { key: "haha", label: "😆 Me divierte", ariaLabels: ["Me divierte", "Haha"] },
  { key: "wow", label: "😮 Me asombra", ariaLabels: ["Me asombra", "Wow"] },
  { key: "sad", label: "😢 Me entristece", ariaLabels: ["Me entristece", "Sad"] },
  { key: "angry", label: "😡 Me enoja", ariaLabels: ["Me enoja", "Angry"] },
];

function reactionSelectorFor(key: string): string {
  const r = REACTIONS.find((x) => x.key === key);
  if (!r?.ariaLabels) return "";
  return r.ariaLabels.map((l) => `div[role="dialog"] div[aria-label="${l}"]`).join(", ");
}

export default function LikeCampaignPage() {
  const [profiles, setProfiles] = useState<PickerProfile[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [platformPreset, setPlatformPreset] = useState("facebook");
  const [selector, setSelector] = useState(PLATFORM_PRESETS.facebook.selector);
  const [reaction, setReaction] = useState("like");
  const [waitMs, setWaitMs] = useState(3000);
  const [staggerSeconds, setStaggerSeconds] = useState(300);
  const [autoRun, setAutoRun] = useState(true);
  const [namePrefix, setNamePrefix] = useState("like");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreatedTask[] | null>(null);

  useEffect(() => {
    Promise.all([
      apiFetch<{ profiles: PickerProfile[] }>("/api/profiles?all=true"),
      apiFetch<{ groups: PickerGroup[] }>("/api/groups?all=true"),
    ])
      .then(([p, g]) => {
        setProfiles(p.profiles);
        setGroups(g.groups);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  function applyPlatformPreset(key: string) {
    setPlatformPreset(key);
    setSelector(PLATFORM_PRESETS[key]?.selector ?? "");
    if (key !== "facebook") setReaction("like");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setResult(null);
    try {
      const { tasks } = await apiFetch<{ tasks: CreatedTask[] }>("/api/tasks/like-campaign", {
        method: "POST",
        body: JSON.stringify({
          url,
          selector,
          reaction,
          reactionSelector: reactionSelectorFor(reaction),
          profileIds: Array.from(selected),
          waitMs,
          staggerSeconds,
          autoRun,
          namePrefix,
        }),
      });
      setResult(tasks);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const count = selected.size;

  return (
    <div className="accent-agua flex animate-fade-in-up flex-col gap-6">
      <div>
        <Link href="/tasks" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Tareas
        </Link>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-series-3 text-white">
            <Heart className="h-4.5 w-4.5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Campaña de likes</h1>
        </div>
        <p className="mt-2 text-sm text-ink-secondary">
          Pega un link, elige los perfiles candidatos y se crea una tarea de like por cada uno.
        </p>
      </div>

      {error && <p className="rounded-xl bg-critical/10 p-3 text-sm text-critical">{error}</p>}

      {result && (
        <Card className="flex animate-fade-in-up flex-col gap-3 border-success/20 bg-success/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="h-4 w-4" />
            Se crearon {result.length} tarea{result.length === 1 ? "" : "s"} de like.
          </p>
          <div className="flex flex-col gap-1.5">
            {result.map((t) => (
              <div key={t._id} className="flex items-center justify-between gap-2">
                <Link href={`/tasks/${t._id}`} className="text-ink hover:text-primary hover:underline">
                  {t.profile.name}
                </Link>
                <StatusBadge status={t.status} />
              </div>
            ))}
          </div>
          <Link href="/tasks" className="mt-1 w-fit text-xs text-primary underline">Ver todas las tareas →</Link>
        </Card>
      )}

      <form onSubmit={submit} className="flex flex-col gap-5 rounded-2xl border border-hairline bg-surface/70 p-5 shadow-sm backdrop-blur-xl">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-muted">Link a likear</label>
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/p/..."
            className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-muted">Plataforma</label>
          <PlatformPicker
            options={Object.entries(PLATFORM_PRESETS).map(([key, p]) => ({ key, label: p.label }))}
            value={platformPreset}
            onChange={applyPlatformPreset}
          />
        </div>

        {platformPreset === "facebook" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Reacción</label>
            <select
              value={reaction}
              onChange={(e) => setReaction(e.target.value)}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
            >
              {REACTIONS.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            {reaction !== "like" && (
              <p className="text-xs text-ink-muted">
                Antes de clickear, la tarea mantiene el cursor sobre el botón de like para que Facebook revele el
                picker de reacciones, y ahí elige esta.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Espaciado entre tareas (minutos)</label>
            <input
              type="number"
              min={0}
              step={0.5}
              value={staggerSeconds / 60}
              onChange={(e) => setStaggerSeconds(Math.max(0, Math.round(Number(e.target.value) * 60)))}
              className="w-40 rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-page hover:text-ink"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Ver ajustes adicionales
          </button>
        </div>

        <label className="flex w-fit items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} className="h-4 w-4 accent-primary" />
          Encolar y ejecutar automáticamente al crear
        </label>
        {!autoRun && (
          <p className="-mt-3 text-xs text-ink-muted">
            Las tareas quedan en &quot;pending&quot;; las ejecutas manualmente desde Tareas.
          </p>
        )}

        <div className="border-t border-hairline pt-4">
          <ProfilePicker profiles={profiles} groups={groups} loading={loading} selected={selected} onChange={setSelected} />
        </div>

        <button
          disabled={creating || count === 0 || !url || !selector}
          className="glow-btn w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
        >
          {creating ? "Creando..." : `Crear ${count || ""} tarea${count === 1 ? "" : "s"} de like`}
        </button>
      </form>

      <Modal open={showAdvanced} onClose={() => setShowAdvanced(false)} title="Ajustes adicionales">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Selector del botón de like</label>
            <input
              required
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder="selector CSS"
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
            />
          </div>

          <p className="text-xs text-ink-muted">
            El selector es un punto de partida: las plataformas cambian su HTML seguido, ajústalo si el like falla.
          </p>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Espera antes de buscar el botón (ms)</label>
            <input
              type="number"
              min={0}
              value={waitMs}
              onChange={(e) => setWaitMs(Number(e.target.value))}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Prefijo de nombre</label>
            <input
              value={namePrefix}
              onChange={(e) => setNamePrefix(e.target.value)}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
