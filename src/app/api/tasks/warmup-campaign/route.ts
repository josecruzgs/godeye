import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import ProfileModel from "@/lib/models/Profile";
import { withApiErrors } from "@/lib/apiHandler";
import { loginIfNeededSteps } from "@/lib/automation/loginSteps";

type Step = {
  action: "goto" | "waitForTimeout" | "scroll" | "click";
  url?: string;
  ms?: number;
  selector?: string;
  optional?: boolean;
};

// Crea una tarea de "warmup" por cada perfil elegido: abre el feed y alterna
// scroll + espera varias veces para simular actividad pasiva, sin interactuar
// con nada — pensado para "calentar" cuentas nuevas antes de usarlas en
// campañas reales.
export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  const homeUrl = typeof body.homeUrl === "string" ? body.homeUrl.trim() : "";
  const profileIds: string[] = Array.isArray(body.profileIds) ? body.profileIds : [];

  if (!homeUrl || profileIds.length === 0) {
    return NextResponse.json(
      { error: "'homeUrl' y al menos un perfil en 'profileIds' son requeridos" },
      { status: 400 },
    );
  }

  await dbConnect();

  const profiles = await ProfileModel.find({ _id: { $in: profileIds } }).sort({ name: 1 });
  if (!profiles.length) {
    return NextResponse.json({ error: "No se encontraron los perfiles seleccionados" }, { status: 404 });
  }

  const initialWaitMs = Number(body.initialWaitMs) > 0 ? Number(body.initialWaitMs) : 3000;
  const waitMs = Number(body.waitMs) > 0 ? Number(body.waitMs) : 4000;
  const scrollPx = Number(body.scrollPx) > 0 ? Number(body.scrollPx) : 800;
  const cycles = Math.min(20, Math.max(1, Number(body.cycles) > 0 ? Number(body.cycles) : 5));
  const staggerSeconds = Number(body.staggerSeconds) >= 0 ? Number(body.staggerSeconds) : 0;
  const autoRun = Boolean(body.autoRun);
  const namePrefix =
    typeof body.namePrefix === "string" && body.namePrefix.trim() ? body.namePrefix.trim() : "warmup";
  const now = Date.now();

  const cycleSteps: Step[] = [];
  for (let i = 0; i < cycles; i++) {
    cycleSteps.push({ action: "scroll", ms: scrollPx });
    cycleSteps.push({ action: "waitForTimeout", ms: waitMs });
  }

  const docs = profiles.map((p, i) => ({
    name: `${namePrefix} · ${p.name}`,
    profileId: p._id,
    type: "warmup" as const,
    steps: [
      { action: "goto" as const, url: homeUrl },
      { action: "waitForTimeout" as const, ms: initialWaitMs },
      ...loginIfNeededSteps(),
      ...cycleSteps,
    ],
    status: autoRun ? ("queued" as const) : ("pending" as const),
    scheduledAt: new Date(now + i * staggerSeconds * 1000),
  }));

  const created = await TaskModel.insertMany(docs);

  const tasks = created.map((t, i) => ({
    _id: t._id,
    name: t.name,
    status: t.status,
    profile: { _id: profiles[i]._id, name: profiles[i].name },
  }));

  return NextResponse.json({ tasks }, { status: 201 });
});
