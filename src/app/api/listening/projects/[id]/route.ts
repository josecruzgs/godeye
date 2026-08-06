import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ListeningProjectModel from "@/lib/models/ListeningProject";
import MentionModel from "@/lib/models/Mention";
import { withApiErrors } from "@/lib/apiHandler";
import {
  normalizeEntities,
  assignEntityKeys,
  DuplicateEntityError,
  type ResolvedEntity,
} from "@/lib/listening/entities";

type Params = { params: Promise<{ id: string }> };

export const GET = withApiErrors(async (_req: NextRequest, { params }: Params) => {
  const { id } = await params;
  await dbConnect();

  const project = await ListeningProjectModel.findById(id).lean();
  if (!project) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  return NextResponse.json({ project });
});

// Solo se aceptan campos de esta lista: un PATCH no debería poder tocar
// lastRunAt ni mentionCount, que los mantiene la ingesta.
const EDITABLE = [
  "name",
  "description",
  "entities",
  "includeTerms",
  "excludeTerms",
  "languages",
  "whitelistDomains",
  "blacklistDomains",
  "rssFeeds",
  "sources",
  "brightDataPlatforms",
  "autoAnalyze",
  "status",
  "intervalMinutes",
] as const;

export const PATCH = withApiErrors(async (req: NextRequest, { params }: Params) => {
  const { id } = await params;
  const body = await req.json();

  const update: Record<string, unknown> = {};
  for (const key of EDITABLE) {
    if (key in body) update[key] = body[key];
  }

  await dbConnect();

  let entities: ResolvedEntity[] | null = null;
  if ("entities" in update) {
    try {
      entities = normalizeEntities(update.entities as ResolvedEntity[]);
      update.entities = entities;
    } catch (err) {
      if (err instanceof DuplicateEntityError) {
        return NextResponse.json({ error: err.message }, { status: 400 });
      }
      throw err;
    }
  }

  const before = entities
    ? ((await ListeningProjectModel.findById(id).select("entities").lean()) as {
        entities: ResolvedEntity[];
      } | null)
    : null;

  const project = await ListeningProjectModel.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true },
  ).lean();

  if (!project) return NextResponse.json({ error: "Proyecto no encontrado" }, { status: 404 });

  // Renombrar una figura tiene que arrastrar su historial. Sin esto, el feed
  // mezclaría el nombre viejo en lo ya guardado y el nuevo en lo que entre
  // después — que es exactamente cómo se veía la duplicación antes de que las
  // figuras tuvieran clave estable.
  if (entities && before) {
    const previous = new Map(
      assignEntityKeys(before.entities ?? []).map((e) => [e.key, e.name] as const),
    );
    for (const entity of entities) {
      if (previous.get(entity.key) && previous.get(entity.key) !== entity.name) {
        await MentionModel.updateMany(
          { projectId: id, entityKey: entity.key },
          { $set: { entity: entity.name } },
        );
      }
    }
  }

  return NextResponse.json({ project });
});

export const DELETE = withApiErrors(async (_req: NextRequest, { params }: Params) => {
  const { id } = await params;
  await dbConnect();

  // Las menciones se borran con el proyecto: sin él no hay forma de
  // consultarlas y quedarían ocupando espacio para siempre.
  await MentionModel.deleteMany({ projectId: id });
  await ListeningProjectModel.findByIdAndDelete(id);

  return NextResponse.json({ ok: true });
});
