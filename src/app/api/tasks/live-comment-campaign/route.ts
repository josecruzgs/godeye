import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CommentModel from "@/lib/models/Comment";
import { withAuth } from "@/lib/apiHandler";
import { findUsableProfiles } from "@/lib/auth/profiles";
import { loginIfNeededSteps } from "@/lib/automation/loginSteps";
import { livePlatformFromUrl } from "@/lib/automation/socialSelectors";
import { addTasksToCampaign, createCampaignWithTasks, readCampaignName } from "@/lib/campaigns";

const MAX_COMENTARIOS_POR_PERFIL = 20;

/**
 * Campaña de comentarios en un live: cada perfil deja varios comentarios del
 * banco, espaciados, mientras dura la transmisión.
 *
 * Cada comentario es una tarea aparte y corta (entrar al live, mirar un rato,
 * comentar, quedarse un poco) y no una sola tarea larga por perfil. Una tarea
 * de 40 minutos ocuparía un motor entero todo ese tiempo —con tres motores,
 * solo tres perfiles estarían en el live— y chocaría con el tope por tarea del
 * worker. Así la cola reparte: entre comentario y comentario de un perfil,
 * los motores atienden a los demás.
 *
 * El reparto es por rondas: en la ronda r cada perfil comenta una vez, y los
 * perfiles se escalonan dentro de la ronda para que el chat no reciba todos
 * los comentarios en el mismo segundo.
 */
export const POST = withAuth(async (user, req: NextRequest) => {
  const body = await req.json();
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const selector = typeof body.selector === "string" ? body.selector.trim() : "";
  const profileIds: string[] = Array.isArray(body.profileIds) ? body.profileIds : [];
  const porPerfil = Math.floor(Number(body.commentsPerProfile));
  const intervaloMin = Number(body.intervalMinutes);

  if (!url || profileIds.length === 0) {
    return NextResponse.json({ error: "'url' y al menos un perfil en 'profileIds' son requeridos" }, { status: 400 });
  }
  if (!livePlatformFromUrl(url) && !selector) {
    return NextResponse.json(
      { error: "El link no es de Facebook, Instagram, TikTok ni YouTube: indica el selector del chat en los ajustes." },
      { status: 400 },
    );
  }
  if (!(porPerfil >= 1 && porPerfil <= MAX_COMENTARIOS_POR_PERFIL)) {
    return NextResponse.json(
      { error: `Los comentarios por perfil van de 1 a ${MAX_COMENTARIOS_POR_PERFIL}` },
      { status: 400 },
    );
  }
  if (porPerfil > 1 && !(intervaloMin >= 0.5)) {
    return NextResponse.json({ error: "El intervalo entre comentarios debe ser de al menos 0.5 minutos" }, { status: 400 });
  }

  await dbConnect();

  const profiles = await findUsableProfiles(user, profileIds);
  if (!profiles.length) {
    return NextResponse.json({ error: "No se encontraron los perfiles seleccionados" }, { status: 404 });
  }

  const total = profiles.length * porPerfil;
  const pool = await CommentModel.find({ ownerId: user.objectId, used: false }).sort({ createdAt: 1 }).limit(total);
  if (pool.length < total) {
    return NextResponse.json(
      {
        error: `Hacen falta ${total} comentario(s) (${profiles.length} perfil(es) × ${porPerfil}) y solo hay ${pool.length} disponibles en el banco. Importa más, baja los comentarios por perfil o elige menos perfiles.`,
      },
      { status: 409 },
    );
  }

  const waitMs = Number(body.waitMs) > 0 ? Number(body.waitMs) : 8000;
  const stayMs = Number(body.stayMs) >= 0 ? Number(body.stayMs) : 15000;
  const delayMin = Number(body.startDelayMinutes) > 0 ? Number(body.startDelayMinutes) : 0;
  const autoRun = Boolean(body.autoRun);
  const namePrefix =
    typeof body.namePrefix === "string" && body.namePrefix.trim() ? body.namePrefix.trim() : "live";
  const campaignName = readCampaignName(body, "livecomment", namePrefix);

  const inicio = Date.now() + delayMin * 60_000;
  const rondaMs = (porPerfil > 1 ? intervaloMin : 1) * 60_000;
  const huecoMs = rondaMs / profiles.length;

  // Ronda por ronda: el comentario k del banco va a la tarea k.
  const plan = Array.from({ length: porPerfil }, (_, ronda) => profiles.map((profile, i) => ({ profile, i, ronda }))).flat();
  const docs = plan.map(({ profile: p, i, ronda }, k) => {
    // Un poco de azar dentro del hueco de cada perfil: un chat donde los
    // mensajes caen con metrónomo se nota armado.
    const azar = k === 0 ? 0 : Math.round((Math.random() - 0.5) * huecoMs * 0.6);
    return {
      name: `${namePrefix} · ${p.name} · ${ronda + 1}/${porPerfil}`,
      profileId: p._id,
      type: "livecomment" as const,
      steps: [
        { action: "goto" as const, url },
        { action: "waitForTimeout" as const, ms: waitMs },
        ...loginIfNeededSteps(),
        { action: "liveComment" as const, value: pool[k].text, ...(selector ? { selector } : {}) },
        // Quedarse viendo un momento después de comentar: entrar, escribir
        // y salir en el mismo segundo es lo que hace un bot.
        ...(stayMs > 0 ? [{ action: "waitForTimeout" as const, ms: stayMs }] : []),
      ],
      status: autoRun ? ("queued" as const) : ("pending" as const),
      scheduledAt: new Date(Math.max(Date.now(), inicio + ronda * rondaMs + i * huecoMs + azar)),
    };
  });
  const claimedIds = pool.map((c) => c._id);

  const campaignId = typeof body.campaignId === "string" ? body.campaignId.trim() : "";

  // Igual que en comentarios: el banco se marca usado solo después de crear
  // las tareas, para que un fallo al insertar no lo deje gastado.
  let campaign;
  let created;
  if (campaignId) {
    const result = await addTasksToCampaign({ user, campaignId, type: "livecomment", docs });
    if (!result.ok) {
      return result.error === "not_found"
        ? NextResponse.json({ error: "Campaña no encontrada" }, { status: 404 })
        : NextResponse.json(
            { error: `La campaña elegida es de tipo "${result.campaignType}", no "livecomment"` },
            { status: 400 },
          );
    }
    campaign = result.campaign;
    created = result.tasks;
  } else {
    const r = await createCampaignWithTasks({
      ownerId: user.objectId,
      name: campaignName,
      type: "livecomment",
      autoRun,
      docs,
    });
    campaign = r.campaign;
    created = r.tasks;
  }

  await Promise.all(
    created.map((t, i) =>
      CommentModel.updateOne(
        { _id: claimedIds[i] },
        { $set: { used: true, usedAt: new Date(), usedByTaskId: t._id } },
      ),
    ),
  );

  const tasks = created.map((t, i) => ({
    _id: t._id,
    name: t.name,
    status: t.status,
    scheduledAt: t.scheduledAt,
    comment: pool[i].text,
    round: plan[i].ronda + 1,
    profile: { _id: plan[i].profile._id, name: plan[i].profile.name },
  }));

  return NextResponse.json(
    {
      campaign: {
        _id: campaign._id,
        name: campaign.name,
        type: campaign.type,
        status: autoRun ? "queued" : "pending",
        taskCount: campaign.taskCount ?? created.length,
      },
      tasks,
    },
    { status: 201 },
  );
});
