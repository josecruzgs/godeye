import { dbConnect } from "@/lib/mongodb";
import ListeningProjectModel from "@/lib/models/ListeningProject";
import MentionModel from "@/lib/models/Mention";
import { PROVIDERS, PROVIDER_ORDER } from "./providers";
import { effectiveDomain, mentionHash, passesFilters } from "./match";
import { assignEntityKeys } from "./entities";
import type { RawMention, SnapshotStore } from "./types";

export type IngestReport = {
  projectId: string;
  fetched: number;
  saved: number;
  duplicates: number;
  filtered: number;
  byProvider: Record<string, { fetched: number; saved: number; error?: string }>;
  errors: string[];
};

/** Ventana por defecto cuando el proyecto nunca corrió: 7 días hacia atrás. */
const FIRST_RUN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** Solapamiento para no perder lo publicado justo en el borde de la ventana. */
const OVERLAP_MS = 10 * 60 * 1000;

type ProjectDoc = {
  _id: unknown;
  entities: { key?: string; name: string; aliases: string[]; profiles?: string[] }[];
  languages: string[];
  rssFeeds: string[];
  includeTerms: string[];
  excludeTerms: string[];
  whitelistDomains: string[];
  blacklistDomains: string[];
  brightDataPlatforms: string[];
  sources: Record<string, boolean>;
  lastRunAt?: Date | null;
  pendingSnapshots?: { key: string; snapshotId: string }[];
};

export async function ingestProject(projectId: string): Promise<IngestReport> {
  await dbConnect();

  const project = (await ListeningProjectModel.findById(projectId).lean()) as ProjectDoc | null;
  if (!project) throw new Error("Proyecto no encontrado");

  const until = new Date();
  const since = project.lastRunAt
    ? new Date(new Date(project.lastRunAt).getTime() - OVERLAP_MS)
    : new Date(until.getTime() - FIRST_RUN_LOOKBACK_MS);

  const report: IngestReport = {
    projectId,
    fetched: 0,
    saved: 0,
    duplicates: 0,
    filtered: 0,
    byProvider: {},
    errors: [],
  };

  const enabled = PROVIDER_ORDER.filter(
    (id) => project.sources?.[id] && PROVIDERS[id].isConfigured(),
  );

  // Scrapes que quedaron en vuelo. Se leen una vez y se mantienen en memoria
  // durante la corrida; cada cambio se persiste enseguida para que sobreviva
  // a una caída del proceso a mitad del polling.
  const pending = new Map(
    (project.pendingSnapshots ?? []).map((s) => [s.key, s.snapshotId] as const),
  );

  const snapshots: SnapshotStore = {
    get: (key) => pending.get(key),
    set: async (key, snapshotId) => {
      pending.set(key, snapshotId);
      await ListeningProjectModel.updateOne(
        { _id: projectId },
        { $pull: { pendingSnapshots: { key } } },
      );
      await ListeningProjectModel.updateOne(
        { _id: projectId },
        { $push: { pendingSnapshots: { key, snapshotId, triggeredAt: new Date() } } },
      );
    },
    clear: async (key) => {
      pending.delete(key);
      await ListeningProjectModel.updateOne(
        { _id: projectId },
        { $pull: { pendingSnapshots: { key } } },
      );
    },
  };

  // Un proyecto guardado antes de que las figuras tuvieran clave estable entra
  // acá sin `key`; recibe el mismo slug que le asignó la reparación, así sus
  // menciones viejas siguen casando en vez de duplicarse.
  const entities = assignEntityKeys(project.entities);

  for (const entity of entities) {
    for (const providerId of enabled) {
      const stats = (report.byProvider[providerId] ??= { fetched: 0, saved: 0 });

      let raw: RawMention[] = [];
      try {
        raw = await PROVIDERS[providerId].fetch({
          entity: {
            key: entity.key,
            name: entity.name,
            aliases: entity.aliases ?? [],
            profiles: entity.profiles ?? [],
          },
          languages: project.languages ?? ["es"],
          rssFeeds: project.rssFeeds ?? [],
          platforms: project.brightDataPlatforms ?? [],
          since,
          until,
          snapshots,
        });
      } catch (err) {
        // Un proveedor caído no invalida la corrida: se anota y se sigue con
        // el resto, que es lo que hace la diferencia entre "sin datos hoy" y
        // "datos parciales de las fuentes que sí respondieron".
        const message = err instanceof Error ? err.message : String(err);
        stats.error = message;
        report.errors.push(`${providerId} · ${entity.name}: ${message}`);
        continue;
      }

      stats.fetched += raw.length;
      report.fetched += raw.length;

      for (const mention of raw) {
        const verdict = passesFilters(mention, {
          includeTerms: project.includeTerms ?? [],
          excludeTerms: project.excludeTerms ?? [],
          whitelistDomains: project.whitelistDomains ?? [],
          blacklistDomains: project.blacklistDomains ?? [],
        });

        if (!verdict.ok) {
          report.filtered += 1;
          continue;
        }

        const hash = mentionHash(projectId, entity.key, mention.url);

        // upsert con $setOnInsert: si la mención ya existe no se pisa (podría
        // tener análisis de sentimiento ya hecho, que cuesta tokens rehacer).
        // El nombre visible sí se refresca, para que un renombre se propague al
        // historial en vez de dejar dos etiquetas conviviendo en el feed.
        const result = await MentionModel.updateOne(
          { projectId, hash },
          {
            $set: { entity: entity.name, entityKey: entity.key },
            $setOnInsert: {
              projectId,
              hash,
              provider: mention.provider,
              platform: mention.platform,
              sourceType: mention.sourceType,
              domain: effectiveDomain(mention),
              url: mention.url,
              title: mention.title,
              text: mention.text,
              author: mention.author,
              authorFollowers: mention.authorFollowers,
              publishedAt: mention.publishedAt,
              lang: mention.lang,
              engagement: mention.engagement,
              reach: mention.reach,
            },
          },
          { upsert: true },
        );

        if (result.upsertedCount > 0) {
          stats.saved += 1;
          report.saved += 1;
        } else {
          report.duplicates += 1;
        }
      }
    }
  }

  const total = await MentionModel.countDocuments({ projectId });

  await ListeningProjectModel.findByIdAndUpdate(projectId, {
    $set: {
      lastRunAt: until,
      lastRunError: report.errors.length > 0 ? report.errors.join(" · ") : null,
      mentionCount: total,
    },
  });

  return report;
}

/** Proyectos activos cuyo intervalo ya venció — los que el worker debe correr. */
export async function findDueProjects(): Promise<string[]> {
  await dbConnect();
  const now = Date.now();

  const projects = (await ListeningProjectModel.find({ status: "active" })
    .select("_id intervalMinutes lastRunAt")
    .lean()) as { _id: unknown; intervalMinutes: number; lastRunAt?: Date | null }[];

  return projects
    .filter((p) => {
      if (!p.lastRunAt) return true;
      const dueAt = new Date(p.lastRunAt).getTime() + (p.intervalMinutes ?? 60) * 60_000;
      return now >= dueAt;
    })
    .map((p) => String(p._id));
}
