import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import WorkerHeartbeatModel, { type WorkerRole } from "@/lib/models/WorkerHeartbeat";
import TaskModel from "@/lib/models/Task";
import ProfileModel from "@/lib/models/Profile";
import { withAuth } from "@/lib/apiHandler";
import { isAdmin, type SessionUser } from "@/lib/auth/dal";
import { MOTORES_TOTALES } from "@/lib/motores";

const ROLES: WorkerRole[] = ["tasks", "listening"];

type MotorTask = {
  id: string;
  name: string;
  type: string;
  profile: string | null;
  campaignId: string | null;
  startedAt: Date | null;
  /** Si el que pregunta puede ver de qué tarea se trata. Ver `motores()`. */
  visible: boolean;
};

type Motor = { engine: number; active: boolean; task: MotorTask | null };

/**
 * Las ranuras de ejecución del worker, con lo que hay corriendo en cada una.
 *
 * Se devuelven siempre las cinco: las que el worker no encendió salen con
 * `active: false` y la sala las dibuja apagadas, para que subir `WORKER_ENGINES`
 * sea encender un hueco que ya existe y no cambiar la pantalla.
 *
 * `online` importa acá: sin latido, las tareas en "running" son huérfanas de un
 * proceso muerto y pintarlas como si estuvieran trabajando sería mentira.
 */
async function motores(user: SessionUser, activos: number, online: boolean): Promise<Motor[]> {
  const vacios = Array.from({ length: MOTORES_TOTALES }, (_, i) => ({
    engine: i + 1,
    active: i < activos,
    task: null,
  }));

  if (!online || activos === 0) return vacios;

  const corriendo = await TaskModel.find({ status: "running" })
    .select("name type engine startedAt ownerId profileId campaignId")
    .sort({ startedAt: 1 })
    .lean();

  if (corriendo.length === 0) return vacios;

  const perfiles = new Map(
    (
      await ProfileModel.find({ _id: { $in: corriendo.map((t) => t.profileId) } })
        .select("name")
        .lean()
    ).map((p) => [String(p._id), p.name as string | undefined]),
  );

  // Un operador ve QUE hay algo corriendo en el motor de al lado —es estado de
  // la máquina, compartida— pero no de quién es ni en qué perfil: eso es la
  // campaña de otro. El admin ve todo, que es lo que ya hace en el resto.
  const todo = isAdmin(user);

  const porMotor = new Map<number, MotorTask>();
  for (const t of corriendo) {
    // Las tareas anteriores a los motores no traen `engine`. Van al 1, que es
    // el único que existía cuando se tomaron.
    const motor = t.engine ?? 1;
    if (motor < 1 || motor > MOTORES_TOTALES || porMotor.has(motor)) continue;

    const propia = todo || String(t.ownerId) === user.id;
    porMotor.set(motor, {
      id: String(t._id),
      name: propia ? (t.name as string) : "Tarea de otro operador",
      type: t.type as string,
      profile: propia ? (perfiles.get(String(t.profileId)) ?? null) : null,
      campaignId: propia && t.campaignId ? String(t.campaignId) : null,
      startedAt: (t.startedAt as Date | undefined) ?? null,
      visible: propia,
    });
  }

  return vacios.map((m) => ({ ...m, task: porMotor.get(m.engine) ?? null }));
}

/**
 * Estado de cada worker. Se informan por separado porque en un deploy real la
 * automatización corre donde está AdsPower y la escucha en el VPS: uno puede
 * estar caído mientras el otro trabaja, y un sí/no único lo ocultaría.
 *
 * `online` queda como estaba —vivo el de tareas— para no romper a quien ya lee
 * ese campo.
 */
// No se acota por usuario: es el estado de la infraestructura, igual para
// todos, y la barra superior lo muestra en cada pantalla. Lo único que sí se
// recorta por usuario es el nombre de lo que corre en cada motor (ver arriba).
export const GET = withAuth(async (user) => {
  await dbConnect();

  const beats = await WorkerHeartbeatModel.find({ _id: { $in: ROLES } }).lean();
  const byRole = new Map(beats.map((b) => [String(b._id), b] as const));

  const status = Object.fromEntries(
    ROLES.map((role) => {
      const beat = byRole.get(role);
      if (!beat) return [role, { online: false, lastSeenAt: null, host: null }];

      // Sin latido en tres intervalos de poll, el proceso está caído.
      const ageMs = Date.now() - new Date(beat.updatedAt).getTime();
      return [
        role,
        {
          online: ageMs <= beat.pollIntervalMs * 3,
          lastSeenAt: beat.updatedAt,
          host: beat.host ?? null,
          ageMs,
        },
      ];
    }),
  ) as Record<WorkerRole, { online: boolean; lastSeenAt: Date | null; host: string | null; ageMs?: number }>;

  // Un worker viejo —o el de escucha solo— no informa `engines`. Se asume 1,
  // que es exactamente lo que hacía antes de que existieran los motores.
  const declarados = byRole.get("tasks")?.engines;
  const activos = Math.min(
    typeof declarados === "number" && declarados > 0 ? declarados : 1,
    MOTORES_TOTALES,
  );

  return NextResponse.json({
    online: status.tasks.online,
    lastSeenAt: status.tasks.lastSeenAt,
    roles: status,
    engines: {
      total: MOTORES_TOTALES,
      active: activos,
      slots: await motores(user, activos, status.tasks.online),
    },
  });
});
