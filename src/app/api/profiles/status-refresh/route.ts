import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { adsPower } from "@/lib/adspower/client";
import { withAuth } from "@/lib/apiHandler";
import { allowedGroupFilter } from "@/lib/auth/dal";

// "lastStatus" solo se actualizaba al usar los botones Iniciar/Detener de
// esta app, así que cualquier perfil sincronizado desde AdsPower (sin haber
// pasado por esos botones) se queda en "unknown" para siempre. Este
// endpoint consulta el estado real en AdsPower para los perfiles de la
// página visible.
//
// Una sola llamada a `local-active` en vez de una por perfil: la Local API
// rate-limitea ~1 req/seg y el cliente serializa las llamadas con ese
// intervalo, así que preguntar de a uno tenía la cola tomada ~22 seg por
// página. Con el listado completo de navegadores abiertos, un perfil está
// activo si aparece ahí.
export const POST = withAuth(async (user, req: NextRequest) => {
  const body = await req.json();
  const ids: string[] = Array.isArray(body.ids) ? body.ids.slice(0, 20) : [];
  if (ids.length === 0) {
    return NextResponse.json({ statuses: {} });
  }

  await dbConnect();
  // Los que caen fuera del alcance simplemente no vuelven: es un refresco de
  // la página visible, no una selección explícita que valga la pena rechazar.
  const profiles = await ProfileModel.find({ _id: { $in: ids }, ...allowedGroupFilter(user) });

  const stored = () =>
    NextResponse.json({
      statuses: Object.fromEntries(profiles.map((p) => [String(p._id), p.lastStatus])),
    });

  // El cliente aborta este POST al cambiar de página; si ya nadie espera la
  // respuesta, no vale la pena gastar el turno en la cola de AdsPower.
  if (req.signal.aborted) return stored();

  let activeIds: Set<string>;
  try {
    const { list } = await adsPower.localActiveBrowsers();
    activeIds = new Set(list.map((b) => b.user_id));
  } catch {
    // AdsPower caído: se devuelve lo guardado tal cual en vez de marcar como
    // inactivos a perfiles que quizá estén corriendo.
    return stored();
  }

  const statuses: Record<string, string> = {};
  const nowActive: unknown[] = [];
  const nowInactive: unknown[] = [];
  for (const profile of profiles) {
    const lastStatus = activeIds.has(profile.adsPowerProfileId) ? "active" : "inactive";
    statuses[String(profile._id)] = lastStatus;
    if (profile.lastStatus !== lastStatus) {
      (lastStatus === "active" ? nowActive : nowInactive).push(profile._id);
    }
  }

  // Dos updates en vez de un save() por perfil: son hasta 20 idas y vueltas a
  // Atlas por cada refresco de página.
  await Promise.all([
    nowActive.length
      ? ProfileModel.updateMany({ _id: { $in: nowActive } }, { $set: { lastStatus: "active" } })
      : undefined,
    nowInactive.length
      ? ProfileModel.updateMany({ _id: { $in: nowInactive } }, { $set: { lastStatus: "inactive" } })
      : undefined,
  ]);

  return NextResponse.json({ statuses });
});
