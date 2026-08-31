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

  return NextResponse.json({ campaigns, total, totals, page, pageSize });
});
