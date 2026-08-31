import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/mongodb";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";
import UserModel from "@/lib/models/User";
import { makeCampaignSummary, type TaskStatusCounts } from "@/lib/campaigns";
import { withAuth } from "@/lib/apiHandler";
import { allowedOwnerFilter, isAdmin, isCliente, requestedOwnerFilter } from "@/lib/auth/dal";
import { escapeRegex } from "@/lib/regex";

type CountRow = {
  _id: { campaignId: Types.ObjectId; status: string };
  count: number;
};

/**
 * Un like a un comentario cuenta como like: para el reporte de campaña es la
 * misma acción, solo cambia dónde cae. Misma definición que el dashboard.
 */
const LIKE_TYPES = ["like", "likecomment"];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Los cuatro KPIs de rendimiento que ve el cliente. Ver `performanceFor`. */
export type CampaignPerformance = {
  likeSuccess: number;
  likeSuccessRate: number | null;
  commentSuccess: number;
  commentSuccessRate: number | null;
  globalSuccessRate: number | null;
  last7: number;
  last7Delta: number;
};

function rate(success: number, failed: number): number | null {
  const total = success + failed;
  return total > 0 ? Math.round((success / total) * 100) : null;
}

/**
 * Likes y comentarios completados, tasa de éxito y lo cerrado en siete días.
 *
 * Son los mismos cuatro números que el dashboard le muestra al admin, pero
 * contados sobre las tareas de ESTAS campañas —las que el filtro dejó pasar— y
 * no sobre todas las tareas del dueño.
 *
 * La diferencia importa: el dashboard cuenta también las tareas sueltas, las
 * que se lanzaron sin campaña, y acá eso rompería la página. "Tareas" ya suma
 * solo lo que cuelga de una campaña, así que si estos cuatro contaran otra cosa
 * los números de la misma pantalla no cerrarían entre sí, que es exactamente la
 * confusión que estos KPIs vienen a evitar.
 */
async function performanceFor(campaignIds: Types.ObjectId[]): Promise<CampaignPerformance> {
  const vacio: CampaignPerformance = {
    likeSuccess: 0,
    likeSuccessRate: null,
    commentSuccess: 0,
    commentSuccessRate: null,
    globalSuccessRate: null,
    last7: 0,
    last7Delta: 0,
  };
  if (campaignIds.length === 0) return vacio;

  const now = Date.now();
  const d7 = new Date(now - WEEK_MS);
  const d14 = new Date(now - 2 * WEEK_MS);

  // Un solo recorrido de las tareas para los cuatro números: agrupar por tipo y
  // estado da likes y comentarios, y las dos ventanas de siete días salen de
  // contar aparte en la misma pasada.
  const [rows] = await TaskModel.aggregate<{
    porTipo: { _id: { type: string; status: string }; count: number }[];
    semanas: { _id: "last7" | "prev7"; count: number }[];
  }>([
    { $match: { campaignId: { $in: campaignIds } } },
    {
      $facet: {
        porTipo: [
          { $match: { status: { $in: ["success", "failed"] } } },
          { $group: { _id: { type: "$type", status: "$status" }, count: { $sum: 1 } } },
        ],
        semanas: [
          { $match: { status: "success", finishedAt: { $gte: d14 } } },
          {
            $group: {
              _id: { $cond: [{ $gte: ["$finishedAt", d7] }, "last7", "prev7"] },
              count: { $sum: 1 },
            },
          },
        ],
      },
    },
  ]);

  let likeSuccess = 0;
  let likeFailed = 0;
  let commentSuccess = 0;
  let commentFailed = 0;
  let success = 0;
  let failed = 0;

  for (const row of rows?.porTipo ?? []) {
    const esExito = row._id.status === "success";
    if (esExito) success += row.count;
    else failed += row.count;

    if (LIKE_TYPES.includes(row._id.type)) {
      if (esExito) likeSuccess += row.count;
      else likeFailed += row.count;
    } else if (row._id.type === "comment") {
      if (esExito) commentSuccess += row.count;
      else commentFailed += row.count;
    }
  }

  const last7 = rows?.semanas.find((s) => s._id === "last7")?.count ?? 0;
  const prev7 = rows?.semanas.find((s) => s._id === "prev7")?.count ?? 0;

  return {
    likeSuccess,
    likeSuccessRate: rate(likeSuccess, likeFailed),
    commentSuccess,
    commentSuccessRate: rate(commentSuccess, commentFailed),
    globalSuccessRate: rate(success, failed),
    last7,
    // Sin semana previa no hay con qué comparar: un 100% es más honesto que un
    // porcentaje inventado sobre cero.
    last7Delta: prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : last7 > 0 ? 100 : 0,
  };
}

/**
 * Los tipos de campaña que trabajan sobre una publicación concreta. Igual que
 * en la ruta del detalle: en warmup y publicaciones el primer `goto` va al muro
 * o al grupo, así que llamarle "la publicación de la campaña" sería mentir.
 */
const CAMPAIGN_TYPES_WITH_POST = ["like", "likecomment", "comment", "ramificacion"];

/**
 * La publicación de cada campaña, sacada del primer `goto` de su primera tarea.
 *
 * Solo se pide para el rol cliente, que en vez de abrir el detalle va derecho
 * al posteo, y solo para las campañas de la página que se está mirando: los
 * `steps` son lo más pesado de una tarea y traer los de las noventa campañas
 * para leer una URL no se paga.
 */
async function postUrlsFor(campaigns: { _id: Types.ObjectId | string; type: string }[]) {
  const ids = campaigns
    .filter((c) => CAMPAIGN_TYPES_WITH_POST.includes(c.type))
    .map((c) => new Types.ObjectId(String(c._id)));
  if (ids.length === 0) return new Map<string, string>();

  const rows = await TaskModel.aggregate<{ _id: Types.ObjectId; url: string | null }>([
    { $match: { campaignId: { $in: ids } } },
    { $sort: { scheduledAt: 1, createdAt: 1 } },
    { $group: { _id: "$campaignId", steps: { $first: "$steps" } } },
    {
      $project: {
        url: {
          $first: {
            $map: {
              input: {
                $filter: {
                  input: { $ifNull: ["$steps", []] },
                  cond: { $and: [{ $eq: ["$$this.action", "goto"] }, { $ne: ["$$this.url", null] }] },
                },
              },
              in: "$$this.url",
            },
          },
        },
      },
    },
  ]);

  return new Map(rows.filter((row) => row.url).map((row) => [String(row._id), row.url as string]));
}

/** username de cada dueño, en una sola consulta para toda la página. */
async function ownerNamesFor(campaigns: { ownerId?: Types.ObjectId | null }[]) {
  const ids = [...new Set(campaigns.map((campaign) => String(campaign.ownerId ?? "")).filter(Boolean))];
  if (ids.length === 0) return new Map<string, string>();

  const rows = await UserModel.find({ _id: { $in: ids } })
    .select("username")
    .lean<{ _id: Types.ObjectId; username: string }[]>();

  return new Map(rows.map((row) => [String(row._id), row.username] as const));
}

export const GET = withAuth(async (user, req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "";
  const type = sp.get("type") ?? "";
  const search = sp.get("search")?.trim();
  const ownerId = sp.get("ownerId") ?? undefined;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || 20));

  await dbConnect();

  // El admin ve las campañas de todos los operadores; el operador, las suyas.
  // El `ownerId` de la query recorta a un operador y solo se le hace caso al
  // admin (ver `requestedOwnerFilter`).
  const filter: Record<string, unknown> = {
    ...allowedOwnerFilter(user),
    ...requestedOwnerFilter(user, ownerId),
  };
  if (type) filter.type = type;
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

  const campaignDocs = await CampaignModel.find(filter).sort({ createdAt: -1 }).lean();
  const campaignIds = campaignDocs.map((campaign) => campaign._id);

  const countRows =
    campaignIds.length > 0
      ? await TaskModel.aggregate<CountRow>([
          { $match: { campaignId: { $in: campaignIds } } },
          { $group: { _id: { campaignId: "$campaignId", status: "$status" }, count: { $sum: 1 } } },
        ])
      : [];

  const countsByCampaign = new Map<string, TaskStatusCounts>();
  for (const row of countRows) {
    const key = String(row._id.campaignId);
    const counts = countsByCampaign.get(key) ?? {};
    counts[row._id.status] = row.count;
    countsByCampaign.set(key, counts);
  }

  // Con el admin mirando, cada campaña dice de quién es: la lista mezcla el
  // trabajo de todos y sin el nombre dos "Likes 12/03 09:15" seguidas son
  // indistinguibles.
  const ownerNames = isAdmin(user) ? await ownerNamesFor(campaignDocs) : new Map<string, string>();

  const summaries = campaignDocs.map((campaign) => ({
    ...makeCampaignSummary({
      campaign,
      counts: countsByCampaign.get(String(campaign._id)) ?? {},
    }),
    owner: ownerNames.get(String(campaign.ownerId)) ?? null,
  }));
  const filtered = status ? summaries.filter((campaign) => campaign.status === status) : summaries;
  const total = filtered.length;
  const paged = filtered.slice((page - 1) * pageSize, page * pageSize);

  // Al cliente la tabla no le abre el detalle: su botón va a la publicación.
  const postUrls = isCliente(user) ? await postUrlsFor(paged) : null;
  const campaigns = postUrls
    ? paged.map((campaign) => ({ ...campaign, postUrl: postUrls.get(String(campaign._id)) ?? null }))
    : paged;

  // Los KPIs de arriba de la página suman TODO lo que cae bajo el filtro, no
  // la página que se está viendo. Se calculan acá porque `filtered` ya son
  // todas las campañas —la paginación es el `slice` de la línea de arriba— y
  // sumarlas en el cliente daba el total de veinte campañas haciéndose pasar
  // por el del sistema.
  const totals = filtered.reduce(
    (acc, campaign) => {
      acc.tasks += campaign.taskCount;
      acc.running += campaign.counts.running;
      acc.queued += campaign.counts.queued;
      acc.success += campaign.counts.success;
      acc.failed += campaign.counts.failed;
      return acc;
    },
    { tasks: 0, running: 0, queued: 0, success: 0, failed: 0 },
  );

  // Los cuatro de rendimiento son la pantalla entera del cliente, así que solo
  // se calculan para él: al resto le sobran, porque tiene el dashboard.
  const performance = isCliente(user)
    ? await performanceFor(filtered.map((campaign) => new Types.ObjectId(String(campaign._id))))
    : null;

  return NextResponse.json({ campaigns, total, totals, performance, page, pageSize });
});
