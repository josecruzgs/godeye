"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Radio, CheckCircle2, SlidersHorizontal } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { LIVE_CHAT_PRESETS } from "@/lib/automation/socialSelectors";
import StatusBadge from "@/components/StatusBadge";
import Card from "@/components/Card";
import Meter from "@/components/Meter";
import Modal from "@/components/Modal";
import ProfilePicker, { type PickerGroup, type PickerProfile } from "@/components/ProfilePicker";
import { platformFromUrl } from "@/lib/platformFromUrl";
import ExistingCampaignPicker from "@/components/ExistingCampaignPicker";

type CreatedTask = {
  _id: string;
  name: string;
  status: string;
  scheduledAt: string;
  comment: string;
  round: number;
  profile: { _id: string; name: string };
};

type CreatedCampaign = {
  _id: string;
  name: string;
  status: string;
  taskCount: number;
};

const inputClass =
  "rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none transition-colors focus:border-primary";

function hora(fecha: Date) {
  return fecha.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" });
}

export default function LiveCommentCampaignPage() {
  const [profiles, setProfiles] = useState<PickerProfile[]>([]);
  const [groups, setGroups] = useState<PickerGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [commentsPerProfile, setCommentsPerProfile] = useState(3);
  const [intervalMinutes, setIntervalMinutes] = useState(5);
  const [startDelayMinutes, setStartDelayMinutes] = useState(0);
  const [autoRun, setAutoRun] = useState(true);
  const [campaignName, setCampaignName] = useState("");
  const [campaignMode, setCampaignMode] = useState<"new" | "existing">("new");
  const [existingCampaignId, setExistingCampaignId] = useState("");

  // Ajustes adicionales
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [selector, setSelector] = useState("");
  const [waitMs, setWaitMs] = useState(8000);
  const [stayMs, setStayMs] = useState(15000);
  const [namePrefix, setNamePrefix] = useState("live");

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<CreatedTask[] | null>(null);
  const [createdCampaign, setCreatedCampaign] = useState<CreatedCampaign | null>(null);

  // La hora de inicio que se muestra: se refresca sola para que el "de 10:05
  // a 10:35" no quede viejo si el formulario se deja abierto.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const [poolTotal, setPoolTotal] = useState(0);
  const [poolAvailable, setPoolAvailable] = useState(0);
  const [manualComments, setManualComments] = useState("");
  const [importing, setImporting] = useState(false);
  const [poolMessage, setPoolMessage] = useState<string | null>(null);

  async function loadProfiles() {
    setLoading(true);
    setError(null);
    try {
      const [p, g] = await Promise.all([
        apiFetch<{ profiles: PickerProfile[] }>("/api/profiles?all=true"),
        apiFetch<{ groups: PickerGroup[] }>("/api/groups?all=true"),
      ]);
      setProfiles(p.profiles);
      setGroups(g.groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function loadPool() {
    try {
      const data = await apiFetch<{ total: number; available: number }>("/api/comments?used=false&limit=1");
      setPoolTotal(data.total);
      setPoolAvailable(data.available);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  useEffect(() => {
    loadProfiles();
    loadPool();
  }, []);

  // Deep-link desde /campanas ("Agregar tareas").
  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get("campaignId");
    if (cid) {
      setCampaignMode("existing");
      setExistingCampaignId(cid);
    }
  }, []);

  async function importManual(e: React.FormEvent) {
    e.preventDefault();
    const comments = manualComments.split("\n").map((l) => l.trim()).filter(Boolean);
    if (comments.length === 0) return;
    setImporting(true);
    setPoolMessage(null);
    setError(null);
    try {
      const data = await apiFetch<{ imported: number; skipped: number }>("/api/comments", {
        method: "POST",
        body: JSON.stringify({ comments }),
      });
      setPoolMessage(`Importados ${data.imported} comentario(s) nuevos (${data.skipped} ya estaban en el banco).`);
      setManualComments("");
      await loadPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setResult(null);
    setCreatedCampaign(null);
    try {
      const { campaign, tasks } = await apiFetch<{ campaign: CreatedCampaign; tasks: CreatedTask[] }>(
        "/api/tasks/live-comment-campaign",
        {
          method: "POST",
          body: JSON.stringify({
            campaignName: campaignMode === "new" ? campaignName : undefined,
            campaignId: campaignMode === "existing" ? existingCampaignId : undefined,
            url,
            selector: selector.trim() || undefined,
            profileIds: Array.from(selected),
            commentsPerProfile,
            intervalMinutes,
            startDelayMinutes,
            waitMs,
            stayMs,
            autoRun,
            namePrefix,
          }),
        },
      );
      setResult(tasks);
      setCreatedCampaign(campaign);
      setSelected(new Set());
      await loadPool();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  const platform = platformFromUrl(url);
  const platformLabel = platform ? LIVE_CHAT_PRESETS[platform]?.label : null;
  const unsupported = Boolean(url) && !platformLabel && !selector.trim();

  const count = selected.size;
  const needed = count * commentsPerProfile;
  const notEnough = needed > poolAvailable;

  // Cuánto dura la campaña: la última ronda arranca en (N-1) × intervalo y se
  // reparte a lo largo de un intervalo más.
  const durationMin = commentsPerProfile > 1 ? commentsPerProfile * intervalMinutes : 1;
  const start = new Date(now + startDelayMinutes * 60_000);
  const end = new Date(start.getTime() + durationMin * 60_000);

  return (
    <div className="flex animate-fade-in-up flex-col gap-6">
      <div>
        <Link href="/tasks" className="inline-flex items-center gap-1 text-xs text-ink-muted hover:text-ink hover:underline">
          <ArrowLeft className="h-3.5 w-3.5" /> Tareas
        </Link>
        <div className="mt-2 flex items-center gap-2.5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] border border-series-5/55 bg-series-5/12 text-series-5">
            <Radio className="h-4.5 w-4.5" />
          </span>
          <h1 className="text-2xl font-semibold text-ink">Comentar en lives</h1>
        </div>
        <p className="mt-2 text-sm text-ink-secondary">
          Pega el link del live, elige los perfiles y cada uno deja varios comentarios del banco, espaciados mientras
          dura la transmisión. Funciona con Facebook, Instagram, TikTok y YouTube.
        </p>
      </div>

      {error && <p className="rounded-xl bg-critical/10 p-3 text-sm text-critical">{error}</p>}

      {result && (
        <Card className="flex animate-fade-in-up flex-col gap-3 border-success/20 bg-success/5 p-4 text-sm">
          <p className="flex items-center gap-2 font-medium text-success">
            <CheckCircle2 className="h-4 w-4" />
            {createdCampaign ? (
              <>
                {campaignMode === "existing" ? "Se agregaron tareas a la campaña" : "Se creó la campaña"}{" "}
                <Link href={`/campanas?campaignId=${createdCampaign._id}`} className="underline">
                  {createdCampaign.name}
                </Link>{" "}
                ({result.length} comentario{result.length === 1 ? "" : "s"} programado{result.length === 1 ? "" : "s"}).
              </>
            ) : (
              <>Se programaron {result.length} comentario{result.length === 1 ? "" : "s"}.</>
            )}
          </p>
          <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
            {result.map((t) => (
              <div key={t._id} className="flex items-center justify-between gap-3">
                <span className="w-12 shrink-0 text-xs tabular-nums text-ink-muted">{hora(new Date(t.scheduledAt))}</span>
                <Link href={`/tasks/${t._id}`} className="shrink-0 text-ink hover:text-primary hover:underline">
                  {t.profile.name}
                </Link>
                <span className="flex-1 truncate text-xs text-ink-muted" title={t.comment}>
                  &quot;{t.comment}&quot;
                </span>
                <StatusBadge status={t.status} />
              </div>
            ))}
          </div>
          {createdCampaign && (
            <Link href={`/campanas?campaignId=${createdCampaign._id}`} className="w-fit text-xs text-primary underline">
              Abrir campaña →
            </Link>
          )}
        </Card>
      )}

      <Card className="flex flex-col gap-3 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-ink">Banco de comentarios</h2>
          <Link href="/tasks/comment" className="text-xs text-ink-muted underline hover:text-ink">
            importar de Sheets o gestionar el banco
          </Link>
        </div>
        <Meter label="Disponibles" value={poolAvailable} total={poolTotal} />
        <p className="text-xs text-ink-muted">
          Es el mismo banco que la campaña de comentarios: cada comentario se usa una sola vez. Si el live termina antes
          de tiempo, los comentarios que no se alcanzaron a publicar vuelven al banco.
        </p>
        {poolMessage && <p className="text-xs text-success">{poolMessage}</p>}
        <form onSubmit={importManual} className="flex flex-col gap-2">
          <label className="text-xs text-ink-muted">Pegar comentarios para el live (uno por línea)</label>
          <textarea
            value={manualComments}
            onChange={(e) => setManualComments(e.target.value)}
            rows={2}
            placeholder={"Saludos desde Culiacán 👋\nQué buen mensaje, así se habla"}
            className={inputClass}
          />
          <button
            disabled={importing || !manualComments.trim()}
            className="w-fit rounded-lg border border-hairline px-3 py-2 text-sm font-medium transition-colors hover:bg-page disabled:opacity-50"
          >
            {importing ? "..." : "Agregar al banco"}
          </button>
        </form>
      </Card>

      <form onSubmit={submit} className="card-surface flex flex-col gap-5 p-5">
        <ExistingCampaignPicker
          type="livecomment"
          mode={campaignMode}
          onModeChange={setCampaignMode}
          campaignId={existingCampaignId}
          onCampaignIdChange={setExistingCampaignId}
        />

        {campaignMode === "new" && (
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Nombre de campaña</label>
            <input
              value={campaignName}
              onChange={(e) => setCampaignName(e.target.value)}
              placeholder="Ej. Live del informe"
              className={inputClass}
            />
          </div>
        )}

        <div className="flex flex-col gap-1">
          <label className="text-xs text-ink-muted">Link del live</label>
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.facebook.com/.../videos/... · tiktok.com/@usuario/live · youtube.com/watch?v=..."
            className={inputClass}
          />
          {platformLabel && <p className="text-xs text-ink-muted">Plataforma detectada: {platformLabel}</p>}
          {unsupported && (
            <p className="text-xs text-warning">
              No se reconoce la plataforma del link. Usa uno de Facebook, Instagram, TikTok o YouTube, o indica el
              selector del chat en los ajustes adicionales.
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Comentarios por perfil</label>
            <input
              type="number"
              min={1}
              max={20}
              value={commentsPerProfile}
              onChange={(e) => setCommentsPerProfile(Math.min(20, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
              className={`w-40 ${inputClass}`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Cada cuánto comenta un perfil (min)</label>
            <input
              type="number"
              min={0.5}
              step={0.5}
              disabled={commentsPerProfile <= 1}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Math.max(0.5, Number(e.target.value) || 0.5))}
              className={`w-40 ${inputClass} disabled:opacity-50`}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Empezar en (min)</label>
            <input
              type="number"
              min={0}
              step={1}
              value={startDelayMinutes}
              onChange={(e) => setStartDelayMinutes(Math.max(0, Number(e.target.value) || 0))}
              className={`w-40 ${inputClass}`}
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

        {count > 0 && (
          <p className="text-xs text-ink-secondary">
            {needed} comentario{needed === 1 ? "" : "s"} en total ({count} perfil{count === 1 ? "" : "es"} ×{" "}
            {commentsPerProfile}), de {hora(start)} a ~{hora(end)} (unos {Math.round(durationMin)} min). Asegúrate de
            que el live siga al aire hasta entonces; si termina antes, la campaña se detiene sola.
          </p>
        )}

        <label className="flex w-fit items-center gap-2 text-sm text-ink-secondary">
          <input type="checkbox" checked={autoRun} onChange={(e) => setAutoRun(e.target.checked)} className="h-4 w-4 accent-primary" />
          Encolar y ejecutar automáticamente al crear
        </label>

        <div className="border-t border-hairline pt-4">
          <ProfilePicker
            profiles={profiles}
            groups={groups}
            loading={loading}
            selected={selected}
            onChange={setSelected}
            pickLeastUsed
            platform={platform}
          />
        </div>

        {notEnough && count > 0 && (
          <p className="text-xs text-warning">
            Hacen falta {needed} comentario(s) y solo hay {poolAvailable} disponibles en el banco. Agrega más, baja los
            comentarios por perfil o elige menos perfiles.
          </p>
        )}

        <button
          disabled={
            creating ||
            count === 0 ||
            !url ||
            unsupported ||
            notEnough ||
            (campaignMode === "existing" && !existingCampaignId)
          }
          className="glow-btn w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md disabled:pointer-events-none disabled:opacity-50"
        >
          {creating
            ? "Creando..."
            : campaignMode === "existing"
              ? `Agregar comentarios al live (${needed})`
              : `Crear campaña de live (${needed})`}
        </button>
      </form>

      <Modal open={showAdvanced} onClose={() => setShowAdvanced(false)} title="Ajustes adicionales">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Selector de la caja del chat (opcional)</label>
            <input
              value={selector}
              onChange={(e) => setSelector(e.target.value)}
              placeholder={platform && LIVE_CHAT_PRESETS[platform] ? "Vacío = el de la plataforma" : "selector CSS"}
              className={inputClass}
            />
            <p className="text-xs text-ink-muted">
              Déjalo vacío para usar el de la plataforma. Solo hace falta si la red cambió su página y el chat no se
              encuentra.
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Espera al entrar, antes de comentar (ms)</label>
            <input type="number" min={0} value={waitMs} onChange={(e) => setWaitMs(Number(e.target.value))} className={inputClass} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Tiempo viendo el live después de comentar (ms)</label>
            <input type="number" min={0} value={stayMs} onChange={(e) => setStayMs(Number(e.target.value))} className={inputClass} />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs text-ink-muted">Prefijo de nombre</label>
            <input value={namePrefix} onChange={(e) => setNamePrefix(e.target.value)} className={inputClass} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
