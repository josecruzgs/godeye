"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Tornado, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { apiFetch } from "@/lib/api";
import StatusBadge from "@/components/StatusBadge";
import Card from "@/components/Card";
import Modal from "@/components/Modal";
import ProfilePicker, { type PickerGroup, type PickerProfile } from "@/components/ProfilePicker";

type CreatedTask = {
  _id: string;
  name: string;
  status: string;
  profile: { _id: string; name: string };
};

type CreatedCampaign = {
  _id: string;
  name: string;
  status: string;
  taskCount: number;
};

export default function ScrappingPage() {
  const [profiles, setProfiles] = useState<PickerProfile[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [waitSelector, setWaitSelector] = useState("");
  const [waitMs, setWaitMs] = useState(3000);
  const [staggerSeconds, setStaggerSeconds] = useState(300);
  const [autoRun, setAutoRun] = useState(true);
  const [namePrefix, setNamePrefix] = useState("scrape");
  const [campaignName, setCampaignName] = useState("");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreatedTask[] | null>(null);
  const [createdCampaign, setCreatedCampaign] = useState<CreatedCampaign | null>(null);

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

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setResult(null);
    setCreatedCampaign(null);
    try {
      const { campaign, tasks } = await apiFetch<{ campaign: CreatedCampaign; tasks: CreatedTask[] }>("/api/tasks/scrape-campaign", {
        method: "POST",
        body: JSON.stringify({
          campaignName,
          url,
          waitSelector,
          profileIds: Array.from(selected),
          waitMs,
          staggerSeconds,
          autoRun,
          namePrefix,
        }),
      });
      setResult(tasks);
      setCreatedCampaign(campaign);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const count = selected.size;

  return (
    <div className="flex animate-fade-in-up flex-col gap-6">
      <div>
        <div className="flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-series-1 text-white">
            <Tornado className="h-4.5 w-4.5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">Campaña de scraping</h1>
        </div>
        <p className="mt-2 text-sm text-ink-secondary">
          Abre un link con cada perfil elegido y guarda una captura de pantalla del resultado en el servidor.
        </p>
        <p className="mt-1 text-xs text-ink-muted">
          El motor de automatización todavía no extrae datos estructurados (texto, listas, etc.) — cada tarea deja
          una imagen en <code className="rounded bg-page px-1 py-0.5">./screenshots/</code> con el id de la tarea y
          el perfil, útil para revisar visualmente el estado de la página por cuenta.
        </p>
      </div>

      {error && <p className="rounded-xl bg-critical/10 p-3 text-sm text-critical">{error}</p>}

      {result && (
        <Card className="flex animate-fade-in-up flex-col gap-3 border-success/20 bg-success/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="h-4 w-4" />
            {createdCampaign ? (
              <>
                Se creó la campaña{" "}
                <Link href={`/campanas?campaignId=${createdCampaign._id}`} className="underline">
                  {createdCampaign.name}
                </Link>{" "}
                con {result.length} tarea{result.length === 1 ? "" : "s"}.
              </>
            ) : (
              <>Se crearon {result.length} tarea{result.length === 1 ? "" : "s"} de scraping.</>
            )}
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
          <div className="mt-1 flex flex-wrap gap-3 text-xs">
            {createdCampaign && (
              <Link href={`/campanas?campaignId=${createdCampaign._id}`} className="w-fit text-primary underline">
                Abrir campaña →
              </Link>
            )}
            <Link href="/tasks" className="w-fit text-primary underline">Ver todas las tareas →</Link>
          </div>
        </Card>
      )}

      <form onSubmit={submit} className="flex flex-col gap-5 rounded-2xl border border-hairline bg-surface/70 p-5 shadow-sm backdrop-blur-xl">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-muted">Nombre de campaña</label>
          <input
            value={campaignName}
            onChange={(e) => setCampaignName(e.target.value)}
            placeholder="Ej. Capturas competencia"
            className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-muted">Link a scrapear</label>
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.instagram.com/alguna-cuenta/"
            className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>

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
          disabled={creating || count === 0 || !url}
          className="glow-btn w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
        >
          {creating ? "Creando..." : `Crear campaña de scraping (${count || 0})`}
        </button>
      </form>

      <Modal open={showAdvanced} onClose={() => setShowAdvanced(false)} title="Ajustes adicionales">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Selector de espera (opcional)</label>
            <input
              value={waitSelector}
              onChange={(e) => setWaitSelector(e.target.value)}
              placeholder="selector CSS que confirma que el contenido cargó"
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary"
            />
          </div>

          <p className="text-xs text-ink-muted">
            Si lo dejas vacío, solo se espera el tiempo fijo antes de capturar la pantalla.
          </p>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Espera antes de capturar (ms)</label>
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
