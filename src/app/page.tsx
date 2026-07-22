import Link from "next/link";
import { Users, FolderKanban, Clock, RefreshCw, Heart, MessageSquare, TrendingUp, CalendarCheck } from "lucide-react";
import { dbConnect } from "@/lib/mongodb";

// Se conecta a Mongo en cada request; evitamos que Next intente
// pre-renderizar esta página en build time (no hay Mongo disponible ahí).
export const dynamic = "force-dynamic";
import ProfileModel from "@/lib/models/Profile";
import GroupModel from "@/lib/models/Group";
import TaskModel from "@/lib/models/Task";
import CommentModel from "@/lib/models/Comment";
import StatCard from "@/components/StatCard";
import Card from "@/components/Card";
import Meter from "@/components/Meter";
import CampaignTrendChart, { type TrendPoint } from "@/components/charts/CampaignTrendChart";
import TopProfilesChart, { type ProfileRow } from "@/components/charts/TopProfilesChart";

const TREND_DAYS = 14;

async function getStats() {
  await dbConnect();

  const now = new Date();
  const since14 = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (TREND_DAYS - 1)));
  const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const d14 = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [
    profiles,
    groups,
    pendingOrQueued,
    running,
    failed,
    success,
    likeSuccess,
    likeFailed,
    commentSuccess,
    commentFailed,
    last7,
    prev7,
    dailyRows,
    topRows,
    commentTotal,
    commentAvailable,
  ] = await Promise.all([
    ProfileModel.countDocuments(),
    GroupModel.countDocuments(),
    TaskModel.countDocuments({ status: { $in: ["pending", "queued"] } }),
    TaskModel.countDocuments({ status: "running" }),
    TaskModel.countDocuments({ status: "failed" }),
    TaskModel.countDocuments({ status: "success" }),
    TaskModel.countDocuments({ type: "like", status: "success" }),
    TaskModel.countDocuments({ type: "like", status: "failed" }),
    TaskModel.countDocuments({ type: "comment", status: "success" }),
    TaskModel.countDocuments({ type: "comment", status: "failed" }),
    TaskModel.countDocuments({ status: "success", finishedAt: { $gte: d7 } }),
    TaskModel.countDocuments({ status: "success", finishedAt: { $gte: d14, $lt: d7 } }),
    TaskModel.aggregate([
      { $match: { type: { $in: ["like", "comment"] }, status: "success", finishedAt: { $gte: since14 } } },
      {
        $group: {
          _id: { day: { $dateToString: { format: "%Y-%m-%d", date: "$finishedAt" } }, type: "$type" },
          count: { $sum: 1 },
        },
      },
    ]),
    TaskModel.aggregate([
      { $match: { type: { $in: ["like", "comment"] }, status: "success" } },
      { $group: { _id: "$profileId", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 6 },
      { $lookup: { from: "profiles", localField: "_id", foreignField: "_id", as: "profile" } },
      { $unwind: "$profile" },
      { $project: { _id: 0, name: "$profile.name", count: 1 } },
    ]),
    CommentModel.countDocuments({}),
    CommentModel.countDocuments({ used: false }),
  ]);

  // El día se agrupa en UTC (default de $dateToString) — se recorre y se
  // formatea también en UTC para que la etiqueta nunca se desfase un día
  // por la zona horaria del servidor.
  const dailyMap = new Map<string, { likes: number; comments: number }>();
  for (let i = 0; i < TREND_DAYS; i++) {
    const d = new Date(since14);
    d.setUTCDate(d.getUTCDate() + i);
    dailyMap.set(d.toISOString().slice(0, 10), { likes: 0, comments: 0 });
  }
  for (const row of dailyRows as { _id: { day: string; type: string }; count: number }[]) {
    const entry = dailyMap.get(row._id.day);
    if (!entry) continue;
    if (row._id.type === "like") entry.likes = row.count;
    else entry.comments = row.count;
  }
  const trend: TrendPoint[] = Array.from(dailyMap.entries()).map(([day, v]) => ({
    day,
    label: new Date(day).toLocaleDateString("es", { day: "2-digit", month: "short", timeZone: "UTC" }),
    ...v,
  }));

  const likeTotal = likeSuccess + likeFailed;
  const commentTaskTotal = commentSuccess + commentFailed;
  const successRateTotal = success + failed;

  return {
    profiles,
    groups,
    pendingOrQueued,
    running,
    likeSuccess,
    commentSuccess,
    likeSuccessRate: likeTotal > 0 ? Math.round((likeSuccess / likeTotal) * 100) : null,
    commentSuccessRate: commentTaskTotal > 0 ? Math.round((commentSuccess / commentTaskTotal) * 100) : null,
    globalSuccessRate: successRateTotal > 0 ? Math.round((success / successRateTotal) * 100) : null,
    last7,
    last7Delta:
      prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : last7 > 0 ? 100 : 0,
    trend,
    topProfiles: topRows as ProfileRow[],
    commentTotal,
    commentAvailable,
  };
}

export default async function Home() {
  const stats = await getStats();

  return (
    <div className="flex animate-fade-in-up flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Dashboard</h1>
        <p className="mt-1 text-sm text-ink-secondary">
          Automatización de cuentas de redes sociales sobre perfiles de Ojo de Dios.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Perfiles" value={stats.profiles} href="/profiles" icon={Users} />
        <StatCard label="Grupos" value={stats.groups} href="/groups" icon={FolderKanban} />
        <StatCard
          label="En cola"
          value={stats.pendingOrQueued}
          href="/tasks?status=queued"
          icon={Clock}
          accent="primary"
        />
        <StatCard
          label="Corriendo"
          value={stats.running}
          href="/tasks?status=running"
          icon={RefreshCw}
          accent="warning"
        />
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          label="Likes completados"
          value={stats.likeSuccess}
          href="/tasks?status=success&type=like"
          icon={Heart}
          accent="series-3"
          delta={stats.likeSuccessRate !== null ? { text: `${stats.likeSuccessRate}% éxito`, positive: stats.likeSuccessRate >= 50 } : undefined}
        />
        <StatCard
          label="Comentarios completados"
          value={stats.commentSuccess}
          href="/tasks?status=success&type=comment"
          icon={MessageSquare}
          accent="series-5"
          delta={stats.commentSuccessRate !== null ? { text: `${stats.commentSuccessRate}% éxito`, positive: stats.commentSuccessRate >= 50 } : undefined}
        />
        <StatCard
          label="Tasa de éxito global"
          value={stats.globalSuccessRate !== null ? `${stats.globalSuccessRate}%` : "—"}
          icon={TrendingUp}
          accent="success"
        />
        <StatCard
          label="Completadas (7 días)"
          value={stats.last7}
          href="/tasks?status=success"
          icon={CalendarCheck}
          delta={stats.last7 > 0 || stats.last7Delta !== 0 ? { text: `${stats.last7Delta >= 0 ? "+" : ""}${stats.last7Delta}% vs. semana anterior`, positive: stats.last7Delta >= 0 } : undefined}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="p-5 xl:col-span-2">
          <h2 className="text-sm font-semibold text-ink">Actividad de campañas · últimos {TREND_DAYS} días</h2>
          <p className="mt-0.5 text-xs text-ink-muted">Likes y comentarios completados con éxito, por día.</p>
          <div className="mt-4">
            <CampaignTrendChart data={stats.trend} />
          </div>
        </Card>

        <Card className="flex flex-col gap-5 p-5">
          <div>
            <h2 className="text-sm font-semibold text-ink">Banco de comentarios</h2>
            <p className="mt-0.5 text-xs text-ink-muted">Comentarios sin usar, listos para la próxima campaña.</p>
            <div className="mt-4">
              <Meter label="Disponibles" value={stats.commentAvailable} total={stats.commentTotal} />
            </div>
          </div>
          <Link
            href="/tasks/comment"
            className="mt-auto flex items-center justify-center rounded-lg border border-hairline px-3 py-2 text-sm font-medium text-ink-secondary transition-colors hover:bg-page hover:text-ink"
          >
            Ir a campaña de comentarios
          </Link>
        </Card>
      </div>

      <Card className="p-5">
        <h2 className="text-sm font-semibold text-ink">Perfiles más activos</h2>
        <p className="mt-0.5 text-xs text-ink-muted">Likes + comentarios completados con éxito, por perfil.</p>
        <div className="mt-4">
          <TopProfilesChart data={stats.topProfiles} />
        </div>
      </Card>

      <Card className="p-5 text-sm">
        <h2 className="font-medium text-ink">Antes de empezar</h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-ink-secondary">
          <li>Abre el cliente de escritorio de Ojo de Dios en esta máquina.</li>
          <li>
            Corre el worker en otra terminal: <code className="rounded bg-page px-1 py-0.5 text-ink">npm run worker</code>
          </li>
          <li>
            Ve a <Link className="text-primary hover:underline" href="/groups">Grupos</Link> para sincronizar/crear grupos.
          </li>
          <li>
            Ve a <Link className="text-primary hover:underline" href="/profiles">Perfiles</Link> para sincronizar perfiles y arrancar/detener navegadores.
          </li>
          <li>
            Crea automatizaciones en <Link className="text-primary hover:underline" href="/tasks">Tareas</Link>.
          </li>
        </ol>
      </Card>
    </div>
  );
}
