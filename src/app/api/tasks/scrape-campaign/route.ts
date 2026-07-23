import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { withApiErrors } from "@/lib/apiHandler";
import { loginIfNeededSteps } from "@/lib/automation/loginSteps";
import { createCampaignWithTasks, readCampaignName } from "@/lib/campaigns";

// Crea una tarea de "scrape" por cada perfil elegido: abre la URL, espera un
// selector de referencia (para asegurar que el contenido cargó) y guarda una
// captura de pantalla en ./screenshots/ (nombrada con el id de la tarea y el
// perfil — ver src/lib/automation/runner.ts). El motor de steps no soporta
// extracción de datos estructurados hoy, solo captura visual.
export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  const url = typeof body.url === "string" ? body.url.trim() : "";
  const waitSelector = typeof body.waitSelector === "string" ? body.waitSelector.trim() : "";
  const profileIds: string[] = Array.isArray(body.profileIds) ? body.profileIds : [];

  if (!url || profileIds.length === 0) {
    return NextResponse.json(
      { error: "'url' y al menos un perfil en 'profileIds' son requeridos" },
      { status: 400 },
    );
  }

  await dbConnect();

  const profiles = await ProfileModel.find({ _id: { $in: profileIds } }).sort({ name: 1 });
  if (!profiles.length) {
    return NextResponse.json({ error: "No se encontraron los perfiles seleccionados" }, { status: 404 });
  }

  const waitMs = Number(body.waitMs) > 0 ? Number(body.waitMs) : 3000;
  const staggerSeconds = Number(body.staggerSeconds) >= 0 ? Number(body.staggerSeconds) : 0;
  const autoRun = Boolean(body.autoRun);
  const namePrefix =
    typeof body.namePrefix === "string" && body.namePrefix.trim() ? body.namePrefix.trim() : "scrape";
  const campaignName = readCampaignName(body, "scrape", namePrefix);
  const now = Date.now();

  const waitStep = waitSelector
    ? [{ action: "waitForSelector" as const, selector: waitSelector, ms: 20000 }]
    : [];

  const docs = profiles.map((p, i) => ({
    name: `${namePrefix} · ${p.name}`,
    profileId: p._id,
    type: "scrape" as const,
    steps: [
      { action: "goto" as const, url },
      { action: "waitForTimeout" as const, ms: waitMs },
      ...loginIfNeededSteps(),
      ...waitStep,
      { action: "screenshot" as const },
    ],
    status: autoRun ? ("queued" as const) : ("pending" as const),
    scheduledAt: new Date(now + i * staggerSeconds * 1000),
  }));

  const { campaign, tasks: created } = await createCampaignWithTasks({
    name: campaignName,
    type: "scrape",
    autoRun,
    docs,
  });

  const tasks = created.map((t, i) => ({
    _id: t._id,
    name: t.name,
    status: t.status,
    profile: { _id: profiles[i]._id, name: profiles[i].name },
  }));

  return NextResponse.json(
    {
      campaign: {
        _id: campaign._id,
        name: campaign.name,
        type: campaign.type,
        status: autoRun ? "queued" : "pending",
        taskCount: created.length,
      },
      tasks,
    },
    { status: 201 },
  );
});
