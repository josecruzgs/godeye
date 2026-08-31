"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import {
  Activity,
  CalendarCheck,
  Eye,
  ExternalLink,
  Heart,
  Megaphone,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Share2,
  Trash2,
  TrendingUp,
  UserX,
  X,
} from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { useSession } from "@/lib/session";
import Card from "@/components/Card";
import ElementIcon from "@/components/ui/ElementIcon";
import Pagination from "@/components/Pagination";
import StatCard from "@/components/StatCard";
import Panel from "@/components/ui/Panel";
import SubHead from "@/components/ui/SubHead";
import CampaignTrendChart, { type TrendPoint } from "@/components/charts/CampaignTrendChart";
import TopProfilesChart, { type ProfileRow } from "@/components/charts/TopProfilesChart";
import StatusBadge, { STATUS_COLORS, STATUS_LABELS } from "@/components/StatusBadge";

type Counts = {
  pending: number;
  queued: number;
  running: number;
  paused: number;
  success: number;
  failed: number;
  cancelled: number;
};

type Campaign = {
  _id: string;
  name: string;
  /** username del dueño. Solo viene con sesión de admin, que ve las de todos. */
  owner?: string | null;
  type: string;
  status: string;
  taskCount: number;
  counts: Counts;
  createdAt: string;
  updatedAt: string;
  /**
   * La publicación sobre la que trabajó la campaña. Solo viaja con sesión de
   * cliente, que en vez de abrir el detalle va derecho al posteo. `null` en las
   * campañas que no trabajan sobre una publicación (warmup, publicaciones).
   */
  postUrl?: string | null;
};

type CampaignTask = {
  _id: string;
  name: string;
  type: string;
  status: string;
  profileId: { _id: string; name: string; adsPowerProfileId?: string } | null;
  scheduledAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
};

type CampaignDetail = {
  campaign: Campaign;
  /** La publicación sobre la que trabaja la campaña, cuando el tipo tiene una. */
  postUrl?: string | null;
  tasks: CampaignTask[];
};

type DeleteProfileResult = {
  ok: boolean;
  adsPowerDeleted: boolean;
  localOnly: boolean;
  deletedTaskCount: number;
};

type Operator = { _id: string; username: string; role: string; active: boolean };

/** Los KPIs de la cabecera, sumados en el servidor sobre todas las campañas del filtro. */
type CampaignTotals = { tasks: number; running: number; queued: number; success: number; failed: number };

const EMPTY_TOTALS: CampaignTotals = { tasks: 0, running: 0, queued: 0, success: 0, failed: 0 };

/**
 * Los cuatro de rendimiento. Solo viajan con sesión de cliente: son su pantalla
 * entera, porque no tiene el dashboard donde el resto los mira.
 */
type CampaignPerformance = {
  likeSuccess: number;
  likeSuccessRate: number | null;
  commentSuccess: number;
  commentSuccessRate: number | null;
  globalSuccessRate: number | null;
  last7: number;
  last7Delta: number;
};

/**
 * Las gráficas de actividad. Caras de calcular, así que el servidor solo las
 * manda cuando se piden con `charts=1`: al entrar y al cambiar un filtro, no en
 * cada refresco de la tabla.
 */
type CampaignCharts = {
  trend: TrendPoint[];
  topProfiles: ProfileRow[];
};

const PAGE_SIZE = 20;
const STATUSES = ["pending", "queued", "running", "paused", "success", "failed", "partial", "cancelled", "empty"];
const TYPES = ["like", "likecomment", "comment", "post", "warmup", "scrape", "custom"];

const TYPE_LABELS: Record<string, string> = {
  like: "Likes",
  likecomment: "Likes a comentarios",
  comment: "Comentarios",
  post: "Publicaciones",
  warmup: "Warmup",
  scrape: "Scrapping",
  custom: "Auto Profile",
  login: "Login",
};

/**
 * Estados desde los que una tarea se puede volver a lanzar.
 *
 * `success` queda afuera a propósito: repetir un like ya dado no lo mejora, lo
 * duplica, y no hay forma de deshacerlo. Los estados en curso —queued,
 * running— tampoco: ya van en camino.
 */
const RELAUNCHABLE_STATUSES = new Set(["failed", "cancelled", "pending", "paused"]);

/**
 * "Relanzar" solo se aplica a lo que ya corrió. Una tarea pendiente o pausada
 * nunca se ejecutó, y llamarle relanzar sugiere una segunda pasada que no
 * existe —justo lo que uno necesita distinguir cuando está mirando por qué
 * algo se duplicó.
 */
function relaunchVerb(status: string) {
  return status === "failed" || status === "cancelled" ? "Relanzar" : "Encolar";
}

/**
 * Si la tarea falló porque Facebook frenó la cuenta.
 *
 * El texto lo escribe `knownFacebookBlocker` en el runner y es el mismo para
 * los cuatro frenos que sabe reconocer (bloqueo, checkpoint, sesión caída,
 * revisión de seguridad). Se busca por `includes` y no por prefijo porque hay
 * pasos que envuelven el mensaje antes de guardarlo.
 */
function frenadoPorFacebook(task: CampaignTask) {
  return Boolean(task.error?.includes("Facebook detuvo este perfil"));
}

// Solo los tipos con un formulario que soporta "agregar a campaña
// existente" (ver ExistingCampaignPicker) tienen a dónde mandar el botón.
const TYPE_ROUTES: Record<string, string> = {
  like: "/tasks/like",
  likecomment: "/tasks/likecomment",
  comment: "/tasks/comment",
  post: "/tasks/post",
  warmup: "/tasks/warmup",
};

export default function CampaignsPage() {
  return (
    <Suspense fallback={<div className="h-64 animate-pulse-soft rounded-2xl bg-surface" />}>
      <CampaignsContent />
    </Suspense>
  );
}

function formatDate(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

/** Solo el día. Es lo que ve el cliente: la hora exacta es ruido de operación. */
function formatDay(value?: string) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

/**
 * El filtro de fechas del cliente. En vez de estados y tipos —vocabulario de
 * operación: "partial", "cancelled", "empty"— se le da la pregunta que sí se
 * hace: qué se movió hoy, ayer, esta semana, este mes.
 */
const DATE_RANGES = [
  { key: "", label: "Todas las fechas" },
  { key: "hoy", label: "Hoy" },
  { key: "ayer", label: "Ayer" },
  { key: "semana", label: "Esta semana" },
  { key: "mes", label: "Este mes" },
  { key: "rango", label: "Rango de fechas" },
] as const;

type DateRangeKey = (typeof DATE_RANGES)[number]["key"];

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

/**
 * El rango en instantes, resuelto en la hora del navegador.
 *
 * Se calcula acá y no en el servidor a propósito: el VPS corre en UTC, y "hoy"
 * para quien mira la pantalla empieza a la medianoche de SU reloj. Es además el
 * mismo huso con el que la columna "Creada" formatea cada fila, así que lo que
 * el filtro deja pasar coincide con las fechas que se leen en la tabla.
 *
 * La semana arranca el lunes, que es la convención de acá y no la de
 * `getDay()`, donde el domingo es 0.
 */
function resolveDateRange(key: DateRangeKey, desde: string, hasta: string): { from?: Date; to?: Date } {
  const now = new Date();

  if (key === "hoy") return { from: startOfDay(now), to: endOfDay(now) };

  if (key === "ayer") {
    const ayer = new Date(now);
    ayer.setDate(ayer.getDate() - 1);
    return { from: startOfDay(ayer), to: endOfDay(ayer) };
  }

  if (key === "semana") {
    const lunes = new Date(now);
    lunes.setDate(lunes.getDate() - ((now.getDay() + 6) % 7));
    return { from: startOfDay(lunes), to: endOfDay(now) };
  }

  if (key === "mes") {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: endOfDay(now) };
  }

  if (key === "rango") {
    // Los <input type="date"> dan "YYYY-MM-DD", que `new Date()` interpreta
    // como medianoche UTC. Se parten a mano para que el día sea el del reloj de
    // quien mira, igual que en los atajos de arriba.
    const parse = (value: string) => {
      const [y, m, d] = value.split("-").map(Number);
      return y && m && d ? new Date(y, m - 1, d) : null;
    };
    const a = parse(desde);
    const b = parse(hasta);
    return { from: a ? startOfDay(a) : undefined, to: b ? endOfDay(b) : undefined };
  }

  return {};
}

function progressFor(campaign: Campaign) {
  const done = campaign.counts.success + campaign.counts.failed + campaign.counts.cancelled;
  if (!campaign.taskCount) return 0;
  return Math.round((done / campaign.taskCount) * 100);
}

function CampaignsContent() {
  const searchParams = useSearchParams();
  const session = useSession();
  // Eliminar un perfil es definitivo y se lleva puestas tareas de campañas que
  // el operador no está mirando; queda del lado de quien administra el parque
  // de perfiles. El mismo rol es el que ve —y edita— las campañas de todos los
  // operadores: por eso también gobierna la columna "Usuario" y su filtro.
  const esAdmin = session?.role === "admin";
  // El cliente es de solo lectura y esta es su única pantalla: entra acá y no
  // hay menú ni a dónde ir. No se le muestran los accesos para crear, ni el
  // detalle de la campaña, ni el desglose de exitosas y fallidas por campaña —
  // lo que se lleva es cuánto se hizo, qué tan bien salió y sobre qué
  // publicación. El servidor ya se lo impide (ver lib/auth/roles.ts); esto es
  // que la pantalla diga lo mismo que el candado.
  const esCliente = session?.role === "cliente";
  const campaignIdParam = searchParams.get("campaignId");

  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [total, setTotal] = useState(0);
  const [totals, setTotals] = useState<CampaignTotals>(EMPTY_TOTALS);
  const [performance, setPerformance] = useState<CampaignPerformance | null>(null);
  const [charts, setCharts] = useState<CampaignCharts | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [type, setType] = useState("");
  const [ownerId, setOwnerId] = useState("");
  // Filtro de fechas del cliente: el atajo elegido, y los dos extremos cuando
  // el atajo es "rango". Ver resolveDateRange.
  const [dateRange, setDateRange] = useState<DateRangeKey>("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [operators, setOperators] = useState<Operator[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CampaignDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [runningPending, setRunningPending] = useState(false);
  const [pausingCampaign, setPausingCampaign] = useState(false);
  const [resumingCampaign, setResumingCampaign] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  // Estado por el que está filtrada la tabla del modal, o null para verlas
  // todas. Vive acá y no en la URL porque muere con el modal.
  const [taskFilter, setTaskFilter] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [retryingBulk, setRetryingBulk] = useState(false);
  const [deletingProfileId, setDeletingProfileId] = useState<string | null>(null);
  // Lo que salió bien. Va aparte de `error` porque eliminar un perfil borra
  // tareas de otras campañas: decir cuántas fueron es la única forma de que se
  // vea lo que pasó fuera de la tabla que se está mirando.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

  // /api/users es solo para admin: al operador ni se le pide.
  useEffect(() => {
    if (!esAdmin) return;
    apiFetch<{ users: Operator[] }>("/api/users")
      .then(({ users }) => setOperators(users))
      .catch(() => {});
  }, [esAdmin]);

  // `withCharts` decide si el servidor recalcula las gráficas de actividad. Va
  // en true al entrar y al cambiar filtros, y en false en el refresco de cada
  // cinco segundos: la curva de catorce días y el podio de perfiles cuestan
  // varios recorridos de la colección de tareas y no cambian de un latido al
  // otro. Cuando no vienen, las que ya están en pantalla se quedan.
  const load = useCallback(
    async (withCharts = false) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        if (search) params.set("search", search);
        if (status) params.set("status", status);
        if (type) params.set("type", type);
        if (ownerId) params.set("ownerId", ownerId);
        // Los extremos se mandan resueltos a instantes: el servidor no tiene
        // por qué saber en qué huso vive quien mira (ver resolveDateRange).
        const { from, to } = resolveDateRange(dateRange, desde, hasta);
        if (from) params.set("from", from.toISOString());
        if (to) params.set("to", to.toISOString());
        if (withCharts) params.set("charts", "1");
        const data = await apiFetch<{
          campaigns: Campaign[];
          total: number;
          totals?: CampaignTotals;
          performance?: CampaignPerformance | null;
          charts?: CampaignCharts | null;
        }>(`/api/campaigns?${params}`);
        setCampaigns(data.campaigns);
        setTotal(data.total);
        setTotals(data.totals ?? EMPTY_TOTALS);
        setPerformance(data.performance ?? null);
        if (data.charts) setCharts(data.charts);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [page, search, status, type, ownerId, dateRange, desde, hasta],
  );

  const loadCampaign = useCallback(async (id: string, silent = false) => {
    if (!silent) setDetailLoading(true);
    setError(null);
    try {
      const data = await apiFetch<CampaignDetail>(`/api/campaigns/${id}`);
      setDetail(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setDetailLoading(false);
    }
  }, []);

  const openCampaign = useCallback(
    async (id: string) => {
      // Un solo portón para el detalle: la tabla ya no le ofrece el botón al
      // cliente, pero a esta función también se llega con ?campaignId= en la
      // URL. (La API le contesta 403 igual; esto evita el modal vacío.)
      if (esCliente) return;
      setSelectedId(id);
      // El filtro no se hereda de la campaña anterior: "fallidas" en una no
      // quiere decir nada en la siguiente, y arrancar con la tabla recortada
      // sin haberlo pedido se lee como que faltan tareas.
      setTaskFilter(null);
      setNotice(null);
      await loadCampaign(id);
    },
    [loadCampaign, esCliente],
  );

  const closeCampaign = useCallback(() => {
    setSelectedId(null);
    setDetail(null);
    setTaskFilter(null);
    setNotice(null);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    // Con gráficas al montar y al cambiar de filtro (`load` se rehace); sin
    // ellas en el latido, que solo está para que "corriendo" y "en cola" se
    // muevan solos.
    load(true);
    const interval = setInterval(() => load(false), 5000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!campaignIdParam || campaignIdParam === selectedId) return;
    openCampaign(campaignIdParam);
  }, [campaignIdParam, openCampaign, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const interval = setInterval(() => loadCampaign(selectedId, true), 5000);
    return () => clearInterval(interval);
  }, [loadCampaign, selectedId]);

  useEffect(() => {
    if (!selectedId) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeCampaign();
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeCampaign, selectedId]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Campaña, Avance, Tipo, Creada y Acciones son fijas; "Usuario" solo la ve el
  // admin y "Tareas" la ve todo el mundo menos el cliente.
  const colSpan = 5 + (esAdmin ? 1 : 0) + (esCliente ? 0 : 1);
  const selectedCampaign = detail?.campaign;
  const pendingInDetail = selectedCampaign?.counts.pending ?? 0;
  const pausableInDetail = (selectedCampaign?.counts.queued ?? 0) + (selectedCampaign?.counts.pending ?? 0);
  const pausedInDetail = selectedCampaign?.counts.paused ?? 0;
  const hasFilters = Boolean(search || status || type || ownerId || dateRange);

  // La tabla del modal recortada al estado elegido. El filtro se aplica sobre
  // lo que ya vino: el detalle trae todas las tareas de la campaña en una sola
  // respuesta, así que no hay nada que volver a pedirle al servidor.
  const visibleTasks = useMemo(
    () => (taskFilter ? (detail?.tasks ?? []).filter((task) => task.status === taskFilter) : (detail?.tasks ?? [])),
    [detail, taskFilter],
  );

  async function runPendingTasks() {
    if (!selectedId) return;
    setRunningPending(true);
    setError(null);
    try {
      await apiFetch(`/api/campaigns/${selectedId}/run`, { method: "POST" });
      await Promise.all([load(), loadCampaign(selectedId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningPending(false);
    }
  }

  /**
   * Vuelve a encolar una tarea suelta. Es el mismo endpoint que usa el botón
   * de la ficha de la tarea: pone `queued` y borra el error viejo, y el worker
   * la recoge en su próxima vuelta.
   */
  async function retryTask(taskId: string) {
    if (!selectedId) return;
    setRetryingId(taskId);
    setError(null);
    try {
      await apiFetch(`/api/tasks/${taskId}/run`, { method: "POST" });
      // silent: la fila cambia sola de estado sin que la tabla parpadee en
      // esqueleto, que con una sola tarea reencolada sería desproporcionado.
      await Promise.all([load(), loadCampaign(selectedId, true)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryingId(null);
    }
  }

  /**
   * Relanza de una todas las tareas del estado filtrado.
   *
   * Con 27 fallidas entre 333, hacerlo fila por fila es el tipo de tarea que
   * uno abandona a la mitad; el botón aparece solo cuando hay un filtro puesto,
   * así que siempre se relanza exactamente lo que está a la vista.
   */
  async function retryFiltered() {
    if (!selectedId || !taskFilter) return;

    const label = (STATUS_LABELS[taskFilter] ?? taskFilter).toLowerCase();
    const ok = confirm(
      `¿${relaunchVerb(taskFilter)} ${visibleTasks.length} ${visibleTasks.length === 1 ? "tarea" : "tareas"} en estado "${label}"?`,
    );
    if (!ok) return;

    setRetryingBulk(true);
    setError(null);
    try {
      await apiFetch(`/api/campaigns/${selectedId}/run`, {
        method: "POST",
        body: JSON.stringify({ status: taskFilter }),
      });
      await Promise.all([load(), loadCampaign(selectedId, true)]);
      // Se sigue el movimiento en vez de dejar la tabla vacía: las tareas
      // acaban de pasar a "en cola", y ahí es donde uno quiere mirar ahora.
      setTaskFilter("queued");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRetryingBulk(false);
    }
  }

  /**
   * Retira del sistema el perfil que Facebook frenó.
   *
   * Vive en la fila de la tarea porque es ahí donde uno se entera: el error de
   * la campaña dice que la cuenta quedó en revisión, y el perfil no va a
   * volver a servir hasta que alguien entre a Facebook a mano. Borra primero
   * las tareas que ya no se van a poder cumplir —si no, el worker seguiría
   * sacándolas de la cola para fallarlas de a una— y después el perfil, de
   * acá y de AdsPower, para que la próxima sincronización no lo traiga de
   * vuelta.
   */
  async function deleteBlockedProfile(task: CampaignTask) {
    const profile = task.profileId;
    if (!profile || !selectedId) return;

    const ok = confirm(
      `¿Eliminar el perfil "${profile.name}"?

Se borran sus tareas fallidas, en cola, pendientes y pausadas de TODAS las campañas, y el perfil sale de esta app y de AdsPower.

Las tareas que ya se cumplieron quedan como registro.`,
    );
    if (!ok) return;

    setDeletingProfileId(profile._id);
    setError(null);
    setNotice(null);
    try {
      let result: DeleteProfileResult;
      try {
        result = await apiFetch<DeleteProfileResult>(`/api/profiles/${profile._id}?withTasks=true`, {
          method: "DELETE",
        });
      } catch (e) {
        // AdsPower se niega a borrar un perfil que sigue abierto. Es el mismo
        // camino de salida que ofrece la pantalla de perfiles: sacarlo solo de
        // acá, avisando que la sincronización puede devolverlo.
        if (!(e instanceof ApiError) || e.status !== 409 || !e.data.canDeleteLocal) throw e;

        const soloLocal = confirm(
          `${e.message}

¿Eliminarlo solo de esta app? Si sigue existiendo en AdsPower, la próxima sincronización lo trae de vuelta.`,
        );
        if (!soloLocal) throw e;

        const local = await apiFetch<DeleteProfileResult>(
          `/api/profiles/${profile._id}?withTasks=true&localOnly=true`,
          { method: "DELETE" },
        );
        // Las tareas se borraron en el primer intento, que es el que las contó.
        result = {
          ...local,
          deletedTaskCount: Number(e.data.deletedTaskCount ?? 0) + (local.deletedTaskCount ?? 0),
        };
      }

      const tareas = result.deletedTaskCount;
      setNotice(
        `Perfil "${profile.name}" eliminado ${result.adsPowerDeleted ? "de esta app y de AdsPower" : "solo de esta app"}. ` +
          `${tareas} ${tareas === 1 ? "tarea pendiente borrada" : "tareas pendientes borradas"}.`,
      );
      await Promise.all([load(), loadCampaign(selectedId, true)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingProfileId(null);
    }
  }

  async function pauseCampaign() {
    if (!selectedId) return;
    setPausingCampaign(true);
    setError(null);
    try {
      await apiFetch(`/api/campaigns/${selectedId}/pause`, { method: "POST" });
      await Promise.all([load(), loadCampaign(selectedId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPausingCampaign(false);
    }
  }

  async function resumeCampaign() {
    if (!selectedId) return;
    setResumingCampaign(true);
    setError(null);
    try {
      await apiFetch(`/api/campaigns/${selectedId}/resume`, { method: "POST" });
      await Promise.all([load(), loadCampaign(selectedId)]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResumingCampaign(false);
    }
  }

  async function deleteCampaign(campaign: Campaign) {
    if (campaign.counts.running > 0) return;

    const ok = confirm(
      `¿Eliminar la campaña "${campaign.name}"? También se eliminarán sus ${campaign.taskCount} tareas.`,
    );
    if (!ok) return;

    setDeletingId(campaign._id);
    setError(null);
    try {
      await apiFetch<{ deletedCampaignId: string; deletedTaskCount: number }>(`/api/campaigns/${campaign._id}`, {
        method: "DELETE",
      });

      if (selectedId === campaign._id) closeCampaign();
      setCampaigns((prev) => prev.filter((item) => item._id !== campaign._id));
      setTotal((prev) => Math.max(0, prev - 1));

      if (campaigns.length === 1 && page > 1) {
        setPage(page - 1);
      } else {
        await load();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingId(null);
    }
  }

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setStatus("");
    setType("");
    setDateRange("");
    setDesde("");
    setHasta("");
    setPage(1);
  }

  return (
    <div className="flex animate-fade-in-up flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] accent-fill border">
            <ElementIcon name={esCliente ? "charla" : "agua"} size={18} />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold text-ink">Campañas</h1>
            <p className="label-mono-sm mt-1">{total} campañas · tareas agrupadas por perfil</p>
          </div>
        </div>
        {/* Todos estos llevan a pantallas de crear: el cliente no las tiene. */}
        <div className={`flex-wrap gap-2 ${esCliente ? "hidden" : "flex"}`}>
          <Link
            href="/campanas/compartir"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
          >
            <Share2 className="h-4 w-4" /> Compartir
          </Link>
          <Link
            href="/tasks/like"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
          >
            <Heart className="h-4 w-4" /> Likes
          </Link>
          <Link
            href="/tasks/comment"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
          >
            <MessageSquare className="h-4 w-4" /> Comentarios
          </Link>
          <Link
            href="/tasks/post"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
          >
            <Megaphone className="h-4 w-4" /> Publicaciones
          </Link>
          <Link
            href="/tasks/warmup"
            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-2 text-sm font-medium text-ink-secondary shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:text-ink hover:shadow-md"
          >
            <Activity className="h-4 w-4" /> Warmup
          </Link>
        </div>
      </div>

      {error && <p className="rounded-xl bg-critical/10 p-3 text-sm text-critical">{error}</p>}

      {/* Rendimiento, solo para el cliente: es la lectura que se lleva de la
          pantalla —cuánto se hizo y qué tan bien salió— y no tiene el
          dashboard donde el resto la mira. Mismas tarjetas y mismos acentos
          que allá, para que sea reconocible. */}
      {esCliente && performance && (
        // `bento` y no una grilla de cuatro: StatCard trae la clase `c3` —tres
        // de doce columnas—, así que en una grilla de cuatro cada tarjeta pedía
        // tres cuartos del ancho y terminaban una por renglón. Sobre las doce
        // del bento, `c3` es exactamente un cuarto y los cuatro entran en línea.
        // `is-stretch` las iguala en alto: "Tasa de éxito global" no lleva
        // pastilla de delta y sin eso quedaba más baja que las otras tres.
        <div className="bento is-stretch">
          <StatCard
            label="Likes completados"
            value={performance.likeSuccess}
            icon={Heart}
            accent="series-3"
            delta={
              performance.likeSuccessRate !== null
                ? {
                    text: `${performance.likeSuccessRate}% éxito`,
                    positive: performance.likeSuccessRate >= 50,
                  }
                : undefined
            }
          />
          <StatCard
            label="Comentarios completados"
            value={performance.commentSuccess}
            icon={MessageSquare}
            accent="series-5"
            delta={
              performance.commentSuccessRate !== null
                ? {
                    text: `${performance.commentSuccessRate}% éxito`,
                    positive: performance.commentSuccessRate >= 50,
                  }
                : undefined
            }
          />
          <StatCard
            label="Tasa de éxito global"
            value={performance.globalSuccessRate !== null ? `${performance.globalSuccessRate}%` : "—"}
            icon={TrendingUp}
            accent="success"
          />
          <StatCard
            label="Completadas · 7 días"
            value={performance.last7}
            icon={CalendarCheck}
            accent="gold"
            delta={
              performance.last7 > 0 || performance.last7Delta !== 0
                ? {
                    text: `${Math.abs(performance.last7Delta)}% vs. semana previa`,
                    positive: performance.last7Delta >= 0,
                  }
                : undefined
            }
          />
        </div>
      )}

      <div className={`grid gap-3 sm:grid-cols-2 ${esCliente ? "lg:grid-cols-3" : "lg:grid-cols-5"}`}>
        <Card className="p-4">
          <p className="label-mono">Tareas</p>
          <p className="stat-value mt-2.5">{totals.tasks}</p>
        </Card>
        <Card className="p-4">
          <p className="label-mono">Corriendo</p>
          <p className="stat-value mt-2.5 text-warning">{totals.running}</p>
        </Card>
        <Card className="p-4">
          <p className="label-mono">En cola</p>
          <p className="stat-value mt-2.5 text-primary">{totals.queued}</p>
        </Card>
        <Card className={`p-4 ${esCliente ? "hidden" : ""}`}>
          <p className="label-mono">Exitosas</p>
          <p className="stat-value mt-2.5 text-success">{totals.success}</p>
        </Card>
        <Card className={`p-4 ${esCliente ? "hidden" : ""}`}>
          <p className="label-mono">Fallidas</p>
          <p className="stat-value mt-2.5 text-critical">{totals.failed}</p>
        </Card>
      </div>

      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative min-w-50 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
          <input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar campaña..."
            className="w-full rounded-lg border border-hairline bg-page py-2 pl-9 pr-3 text-sm outline-none transition-colors focus:border-primary"
          />
        </div>
        {/* Al cliente, fechas en vez de estados y tipos: "partial", "empty" o
            "warmup" son vocabulario de operación, y lo que él se pregunta es
            qué se movió hoy o esta semana. */}
        {esCliente ? (
          <>
            <select
              value={dateRange}
              onChange={(e) => {
                setDateRange(e.target.value as DateRangeKey);
                setPage(1);
              }}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            >
              {DATE_RANGES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
            {dateRange === "rango" && (
              <>
                <input
                  type="date"
                  value={desde}
                  max={hasta || undefined}
                  onChange={(e) => {
                    setDesde(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Desde"
                  className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
                />
                <span className="text-xs text-ink-muted">a</span>
                <input
                  type="date"
                  value={hasta}
                  min={desde || undefined}
                  onChange={(e) => {
                    setHasta(e.target.value);
                    setPage(1);
                  }}
                  aria-label="Hasta"
                  className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
                />
              </>
            )}
          </>
        ) : (
          <>
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">Todos los estados</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setPage(1);
              }}
              className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
            >
              <option value="">Todos los tipos</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t] ?? t}
                </option>
              ))}
            </select>
          </>
        )}
        {esAdmin && (
          <select
            value={ownerId}
            onChange={(e) => {
              setOwnerId(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-hairline bg-page px-3 py-2 text-sm outline-none focus:border-primary"
          >
            <option value="">Todos los usuarios</option>
            {operators.map((u) => (
              <option key={u._id} value={u._id}>
                {u.username}
                {u.active ? "" : " (inactivo)"}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => load(true)}
          title="Actualizar"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
        {hasFilters && (
          <button type="button" onClick={clearFilters} className="text-xs text-ink-muted underline hover:text-ink">
            Limpiar filtros
          </button>
        )}
      </Card>

      {/* Actividad, solo para el cliente: las mismas chapas del dashboard,
          contadas sobre las campañas que el filtro dejó pasar. `bento` es la
          rejilla de doce columnas que entienden los `col` de Panel, y
          `is-stretch` empareja el alto de la curva y el podio, que van lado a
          lado y cada uno crecía lo que le pedía su contenido. */}
      {esCliente && charts && (
        <div className="bento is-stretch">
          <SubHead>Actividad</SubHead>

          <Panel
            col={8}
            title="Actividad de campañas · últimos 14 días"
            tag="likes + comentarios"
            accent="var(--el-agua)"
            icon={<ElementIcon name="charla" size={13} />}
          >
            <CampaignTrendChart data={charts.trend} />
          </Panel>

          {/* En las cuatro columnas que dejó el banco de comentarios, que era
              inventario de operación y no le decía nada al cliente. */}
          <Panel
            col={4}
            title="Perfiles más activos"
            tag="likes + comentarios exitosos"
            accent="var(--el-viento)"
            icon={<ElementIcon name="viento" size={13} />}
          >
            <TopProfilesChart data={charts.topProfiles} />
          </Panel>
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-hairline text-left text-xs uppercase tracking-wide text-ink-muted">
              <tr>
                <th className="px-4 py-3 font-medium">Campaña</th>
                {esAdmin && <th className="px-4 py-3 font-medium">Usuario</th>}
                <th className="px-4 py-3 font-medium">Avance</th>
                {!esCliente && <th className="px-4 py-3 font-medium">Tareas</th>}
                <th className="px-4 py-3 font-medium">Tipo</th>
                <th className="px-4 py-3 font-medium">Creada</th>
                <th className="px-4 py-3 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading && campaigns.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-10 text-center text-ink-muted">
                    Cargando...
                  </td>
                </tr>
              ) : campaigns.length === 0 ? (
                <tr>
                  <td colSpan={colSpan} className="px-4 py-10 text-center text-ink-muted">
                    Sin campañas todavía.
                  </td>
                </tr>
              ) : (
                campaigns.map((campaign) => {
                  const progress = progressFor(campaign);
                  return (
                    <tr key={campaign._id} className="border-t border-hairline transition-colors hover:bg-page/60">
                      <td className="px-4 py-3">
                        {esCliente ? (
                          <span className="block max-w-80 truncate font-medium text-ink">{campaign.name}</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openCampaign(campaign._id)}
                            className="max-w-80 text-left font-medium text-ink hover:text-primary hover:underline"
                          >
                            <span className="block truncate">{campaign.name}</span>
                          </button>
                        )}
                      </td>
                      {esAdmin && (
                        <td className="px-4 py-3 text-ink-secondary">{campaign.owner ?? "—"}</td>
                      )}
                      <td className="px-4 py-3">
                        <div className="flex min-w-36 items-center gap-2">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-page">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${progress}%` }} />
                          </div>
                          <span className="w-9 text-right text-xs text-ink-muted">{progress}%</span>
                        </div>
                      </td>
                      {!esCliente && (
                        <td className="px-4 py-3 text-ink-secondary">
                          {campaign.taskCount}
                          <span className="ml-2 text-xs text-ink-muted">
                            {campaign.counts.success} ok / {campaign.counts.failed} fail
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-3 text-ink-secondary">{TYPE_LABELS[campaign.type] ?? campaign.type}</td>
                      <td className="px-4 py-3 text-ink-secondary">
                        {esCliente ? formatDay(campaign.createdAt) : formatDate(campaign.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          {esCliente ? (
                            // Al cliente el botón lo lleva a la publicación
                            // sobre la que trabajó la campaña, no al detalle.
                            // Las campañas sin posteo (warmup, publicaciones)
                            // lo muestran apagado en vez de esconderlo, para
                            // que la columna no se descuadre entre filas.
                            <a
                              href={campaign.postUrl ?? undefined}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-disabled={!campaign.postUrl}
                              title={
                                campaign.postUrl
                                  ? "Abrir la publicación · se abre en otra pestaña"
                                  : "Esta campaña no trabaja sobre una publicación"
                              }
                              className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline transition-colors ${
                                campaign.postUrl
                                  ? "text-ink-muted hover:bg-page hover:text-ink"
                                  : "pointer-events-none opacity-40"
                              }`}
                            >
                              <ExternalLink className="h-4 w-4" />
                            </a>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openCampaign(campaign._id)}
                              title="Ver perfiles y tareas"
                              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink"
                            >
                              <Eye className="h-4 w-4" />
                            </button>
                          )}
                          {!esCliente && (
                          <button
                            type="button"
                            disabled={deletingId === campaign._id || campaign.counts.running > 0}
                            onClick={() => deleteCampaign(campaign)}
                            title={
                              campaign.counts.running > 0
                                ? "No se puede eliminar mientras hay tareas corriendo"
                                : "Eliminar campaña"
                            }
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:border-critical/40 hover:bg-critical/10 hover:text-critical disabled:pointer-events-none disabled:opacity-40"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="border-t border-hairline px-2">
          <Pagination page={page} totalPages={totalPages} totalItems={total} pageSize={PAGE_SIZE} onChange={setPage} />
        </div>
      </Card>

      {mounted &&
        selectedId &&
        createPortal(
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm sm:p-6"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeCampaign();
            }}
          >
            <Card className="flex h-[calc(100dvh-1.5rem)] w-full max-w-6xl flex-col overflow-hidden sm:h-[calc(100dvh-3rem)]">
            <div className="shrink-0 border-b border-hairline p-4 sm:p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-xl font-semibold tracking-tight text-ink">
                    {selectedCampaign?.name ?? "Campaña"}
                  </h2>
                  {selectedCampaign && <StatusBadge status={selectedCampaign.status} />}
                </div>
                {selectedCampaign && (
                  <p className="mt-1 text-sm text-ink-secondary">
                    {TYPE_LABELS[selectedCampaign.type] ?? selectedCampaign.type} · {selectedCampaign.taskCount} perfiles
                    {/* Quién la armó, para que el admin sepa a quién le está
                        tocando la campaña antes de pausarla o relanzarla. */}
                    {esAdmin && selectedCampaign.owner ? ` · ${selectedCampaign.owner}` : ""}
                  </p>
                )}
                {/* Una sola vez acá arriba y no en cada fila: las tareas de la
                    campaña son el mismo posteo repartido entre perfiles, así
                    que 300 enlaces idénticos serían 300 formas de abrir la
                    misma pestaña. */}
                {detail?.postUrl && (
                  <a
                    href={detail.postUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={detail.postUrl}
                    className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-lg border border-hairline bg-page px-2.5 py-1.5 text-xs font-medium text-ink-secondary transition-colors hover:text-ink"
                  >
                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">Ver publicación</span>
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                {selectedCampaign && TYPE_ROUTES[selectedCampaign.type] && (
                  <Link
                    href={`${TYPE_ROUTES[selectedCampaign.type]}?campaignId=${selectedCampaign._id}`}
                    title="Elegir más perfiles y sumarlos a esta campaña"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-page px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:text-ink"
                  >
                    <Plus className="h-4 w-4" /> Agregar tareas
                  </Link>
                )}
                <button
                  type="button"
                  disabled={!pendingInDetail || runningPending}
                  onClick={runPendingTasks}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-page px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                >
                  <Play className="h-4 w-4" /> {runningPending ? "Encolando..." : "Ejecutar pendientes"}
                </button>
                {pausedInDetail > 0 ? (
                  <button
                    type="button"
                    disabled={resumingCampaign}
                    onClick={resumeCampaign}
                    title="Reanudar las tareas pausadas de esta campaña"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-sm font-medium text-success transition-colors hover:bg-success/20 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Play className="h-4 w-4" /> {resumingCampaign ? "Reanudando..." : "Reanudar"}
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!pausableInDetail || pausingCampaign}
                    onClick={pauseCampaign}
                    title="Pausar tareas pendientes/en cola para corregir algo antes de seguir"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-page px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Pause className="h-4 w-4" /> {pausingCampaign ? "Pausando..." : "Pausar"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => loadCampaign(selectedId)}
                  title="Actualizar detalle"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={closeCampaign}
                  title="Cerrar"
                  className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
              {/* El aviso se repite acá dentro: el del pie de la página queda
                  detrás del overlay y con el modal abierto no se ve nada. */}
              {notice && <p className="mb-4 rounded-xl bg-success/10 p-3 text-sm text-success">{notice}</p>}
              {error && <p className="mb-4 rounded-xl bg-critical/10 p-3 text-sm text-critical">{error}</p>}
              {detailLoading && !detail ? (
                <div className="h-48 animate-pulse-soft rounded-xl bg-page" />
              ) : detail ? (
                <div className="flex flex-col gap-4">
                  {/* Las tarjetas de conteo son el filtro de la tabla: es donde
                      uno ya está mirando cuando piensa "a ver esas 27
                      fallidas", y así no hace falta un control aparte que
                      repita la misma lista de estados. Las que están en cero no
                      se pueden pulsar: filtrar por ellas solo daría una tabla
                      vacía. */}
                  <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                    {Object.entries(detail.campaign.counts).map(([key, value]) => {
                      const active = taskFilter === key;
                      const color = STATUS_COLORS[key] ?? "var(--text-muted)";
                      const label = STATUS_LABELS[key] ?? key;

                      return (
                        <button
                          key={key}
                          type="button"
                          disabled={!value}
                          aria-pressed={active}
                          onClick={() => setTaskFilter(active ? null : key)}
                          title={
                            !value
                              ? `No hay tareas en ${label.toLowerCase()}`
                              : active
                                ? "Quitar el filtro y ver todas las tareas"
                                : `Ver solo las ${value} en ${label.toLowerCase()}`
                          }
                          className="rounded-xl border border-hairline bg-page p-3 text-left transition-colors hover:border-ink-muted disabled:pointer-events-none disabled:opacity-40"
                          style={
                            active
                              ? {
                                  borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
                                  background: `color-mix(in srgb, ${color} 10%, transparent)`,
                                }
                              : undefined
                          }
                        >
                          <p className="label-mono" style={active ? { color } : undefined}>
                            {key}
                          </p>
                          <p className="mt-1 text-lg font-semibold text-ink">{value}</p>
                        </button>
                      );
                    })}
                  </div>

                  {taskFilter && (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-hairline bg-page px-3 py-2">
                      <p className="text-sm text-ink-secondary">
                        Mostrando <span className="font-semibold text-ink">{visibleTasks.length}</span> de{" "}
                        {detail.tasks.length} · {STATUS_LABELS[taskFilter] ?? taskFilter}
                      </p>

                      <div className="ml-auto flex items-center gap-2">
                        {RELAUNCHABLE_STATUSES.has(taskFilter) && visibleTasks.length > 0 && (
                          <button
                            type="button"
                            disabled={retryingBulk}
                            onClick={retryFiltered}
                            title="Encolar todas las tareas que estás viendo"
                            className="inline-flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                            {retryingBulk ? "Encolando..." : `${relaunchVerb(taskFilter)} ${visibleTasks.length}`}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => setTaskFilter(null)}
                          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-ink-muted transition-colors hover:text-ink"
                        >
                          <X className="h-3.5 w-3.5" /> Quitar filtro
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="overflow-x-auto rounded-xl border border-hairline">
                    <table className="w-full text-sm">
                      <thead className="border-b border-hairline text-left text-xs uppercase tracking-wide text-ink-muted">
                        <tr>
                          <th className="px-4 py-3 font-medium">Perfil</th>
                          <th className="px-4 py-3 font-medium">Tarea</th>
                          <th className="px-4 py-3 font-medium">Estado</th>
                          <th className="px-4 py-3 font-medium">Programada</th>
                          <th className="px-4 py-3 font-medium">Terminó</th>
                          <th className="px-4 py-3 font-medium">Error</th>
                          <th className="px-4 py-3 font-medium">Acciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleTasks.map((task) => (
                          <tr key={task._id} className="border-t border-hairline">
                            <td className="px-4 py-3">
                              <p className="font-medium text-ink">{task.profileId?.name ?? "Sin perfil"}</p>
                              {task.profileId?.adsPowerProfileId && (
                                <p className="text-xs text-ink-muted">{task.profileId.adsPowerProfileId}</p>
                              )}
                            </td>
                            <td className="px-4 py-3 text-ink-secondary">{task.name}</td>
                            <td className="px-4 py-3">
                              <StatusBadge status={task.status} />
                            </td>
                            <td className="px-4 py-3 text-ink-secondary">{formatDate(task.scheduledAt)}</td>
                            <td className="px-4 py-3 text-ink-secondary">{formatDate(task.finishedAt)}</td>
                            <td className="max-w-72 px-4 py-3 text-xs text-critical">
                              {task.error ? <span className="line-clamp-3">{task.error}</span> : "—"}
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex items-center gap-1.5">
                                {/* Relanzar vive en la fila y no solo en la
                                    ficha de la tarea: con el filtro de fallidas
                                    puesto, el error y el botón que lo corrige
                                    quedan a la misma altura y se puede ir
                                    bajando de una. */}
                                {RELAUNCHABLE_STATUSES.has(task.status) && (
                                  <button
                                    type="button"
                                    disabled={retryingId === task._id}
                                    onClick={() => retryTask(task._id)}
                                    title={
                                      relaunchVerb(task.status) === "Relanzar"
                                        ? "Volver a lanzar esta tarea"
                                        : "Encolar esta tarea ahora"
                                    }
                                    aria-label={
                                      relaunchVerb(task.status) === "Relanzar"
                                        ? "Volver a lanzar esta tarea"
                                        : "Encolar esta tarea ahora"
                                    }
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink disabled:pointer-events-none disabled:opacity-40"
                                  >
                                    <RotateCcw
                                      className={`h-4 w-4 ${retryingId === task._id ? "animate-spin" : ""}`}
                                    />
                                  </button>
                                )}
                                <Link
                                  href={`/tasks/${task._id}`}
                                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline text-ink-muted transition-colors hover:bg-page hover:text-ink"
                                  title="Abrir tarea"
                                >
                                  <Eye className="h-4 w-4" />
                                </Link>
                                {/* Solo cuando el error es el freno de
                                    Facebook: un perfil se elimina una vez y no
                                    hay vuelta atrás, así que el botón no se
                                    ofrece al lado de cualquier fallo pasajero. */}
                                {esAdmin && frenadoPorFacebook(task) && task.profileId && (
                                  <button
                                    type="button"
                                    disabled={deletingProfileId === task.profileId._id}
                                    onClick={() => deleteBlockedProfile(task)}
                                    title="Facebook frenó este perfil: eliminarlo del sistema y de AdsPower, con sus tareas en cola"
                                    aria-label="Eliminar este perfil del sistema"
                                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-critical/30 text-critical transition-colors hover:bg-critical/10 disabled:pointer-events-none disabled:opacity-40"
                                  >
                                    <UserX className="h-4 w-4" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                        {!visibleTasks.length && (
                          <tr className="border-t border-hairline">
                            <td colSpan={7} className="px-4 py-10 text-center text-sm text-ink-muted">
                              {taskFilter
                                ? `Ninguna tarea en ${(STATUS_LABELS[taskFilter] ?? taskFilter).toLowerCase()}.`
                                : "Esta campaña todavía no tiene tareas."}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : (
                <p className="py-12 text-center text-sm text-ink-muted">No se pudo cargar la campaña.</p>
              )}
            </div>
            </Card>
          </div>,
          document.body,
        )}
    </div>
  );
}
