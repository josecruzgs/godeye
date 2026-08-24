import { config } from "dotenv";
config({ path: ".env.local" });

import { hostname } from "os";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import WorkerHeartbeatModel, { type WorkerRole } from "@/lib/models/WorkerHeartbeat";
import ListeningProjectModel from "@/lib/models/ListeningProject";
import { runTask } from "@/lib/automation/runner";
import { findDueProjects, ingestProject } from "@/lib/listening/ingest";
import { analyzeMentions } from "@/lib/listening/analyze";
import { generateNextBriefWindow } from "@/lib/listening/briefSchedule";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);

/**
 * Tope duro por tarea. Pasado esto, el worker se da por colgado y se mata.
 *
 * Veinte minutos porque un warmup largo es legítimamente lento: hasta 20
 * ciclos con la espera que haya elegido el usuario. El número no busca acertar
 * cuánto tarda una tarea, sino poner un techo donde antes no había ninguno.
 *
 * Se puede subir con `WORKER_TASK_TIMEOUT_MS` si alguna campaña lo pide.
 */
const TASK_TIMEOUT_MS = Number(process.env.WORKER_TASK_TIMEOUT_MS ?? 20 * 60 * 1000);

/**
 * Los dos trabajos del worker se pueden encender por separado porque tienen
 * requisitos de máquina incompatibles: la automatización necesita AdsPower de
 * escritorio corriendo en el mismo equipo, y la escucha solo necesita salida a
 * internet. En un deploy real eso son dos procesos —uno en el VPS con
 * `WORKER_TASKS=0`, otro en la máquina con AdsPower y `WORKER_LISTENING=0`—
 * coordinados por Mongo, que es de donde ambos toman el trabajo.
 *
 * Por defecto los dos están encendidos: en local un solo proceso hace todo.
 */
function enabled(name: string): boolean {
  const raw = process.env[name];
  return raw === undefined || !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

const ROLES: WorkerRole[] = [
  ...(enabled("WORKER_TASKS") ? (["tasks"] as const) : []),
  ...(enabled("WORKER_LISTENING") ? (["listening"] as const) : []),
];

const HOST = hostname();

// La escucha no se revisa en cada tick: los proveedores tienen su propio
// intervalo por proyecto (por defecto 60 min) y consultarlos cada 5 segundos
// solo gastaría llamadas. Un minuto de resolución alcanza de sobra.
const LISTENING_CHECK_MS = 60_000;
let lastListeningCheck = 0;

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function heartbeat() {
  // Un latido por rol activo: así la UI puede decir "la escucha corre pero la
  // automatización no" en vez de un sí/no que en dos máquinas sería mentira.
  for (const role of ROLES) {
    await WorkerHeartbeatModel.findByIdAndUpdate(
      role,
      { $set: { pollIntervalMs: POLL_INTERVAL_MS, host: HOST } },
      { upsert: true },
    );
  }
}

/** Marca la señal de que el tope de tiempo ganó la carrera contra la tarea. */
class TareaColgada extends Error {}

/**
 * Corre la tarea con un tope de tiempo.
 *
 * `runTask` no tiene ningún límite propio y encadena esperas de red que
 * tampoco lo tenían: si alguna no vuelve, este `await` no vuelve nunca y la
 * cola entera se detiene detrás.
 */
async function ejecutarConTope(taskId: string) {
  const trabajo = runTask(taskId);

  // Si gana el tope, `trabajo` sigue viva y su rechazo posterior se quedaría
  // sin dueño: Node 22 mata el proceso por `unhandledRejection`. Este catch le
  // pone dueño sin tocar la carrera de abajo, que tiene el suyo.
  trabajo.catch(() => {});

  let temporizador: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      trabajo,
      new Promise<never>((_, reject) => {
        temporizador = setTimeout(
          () => reject(new TareaColgada(`Sin terminar tras ${Math.round(TASK_TIMEOUT_MS / 60_000)} min`)),
          TASK_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Cierra como fallida una tarea que quedó tomada.
 *
 * Condicionado a que siga en "running": si `runTask` ya escribió su estado
 * definitivo, ese vale más que lo que sepamos desde acá.
 */
async function cerrarComoFallida(taskId: string, motivo: string) {
  await TaskModel.updateOne(
    { _id: taskId, status: "running" },
    { $set: { status: "failed", error: motivo, finishedAt: new Date() } },
  );
}

async function tick() {
  const task = await TaskModel.findOneAndUpdate(
    { status: "queued", scheduledAt: { $lte: new Date() } },
    { $set: { status: "running" } },
    { sort: { scheduledAt: 1 }, returnDocument: "after" },
  );

  if (!task) return;

  console.log(`[worker] ejecutando tarea ${task._id} (${task.name})`);
  try {
    // runTask vuelve a marcar running/success/failed y escribe logs;
    // aquí solo evitamos que dos ticks tomen la misma tarea.
    await ejecutarConTope(String(task._id));
  } catch (err) {
    const motivo = err instanceof Error ? err.message : String(err);
    console.error(`[worker] error en tarea ${task._id}:`, err);

    // `runTask` sabe marcar `failed`, pero solo desde su propio try, al que no
    // llega si revienta antes —un perfil borrado es el caso habitual—. Esos
    // errores salían por acá, se imprimían y nada más: `tick` ya había puesto
    // la tarea en "running" al tomarla, así que quedaba ahí para siempre, sin
    // error visible y sin contar como fallida en ningún lado.
    await cerrarComoFallida(String(task._id), motivo).catch((cerrarErr) =>
      console.error(`[worker] no se pudo cerrar la tarea ${task._id}:`, cerrarErr),
    );

    if (err instanceof TareaColgada) {
      // Salir, y no seguir con la siguiente: la tarea abandonada sigue viva en
      // este proceso, con su conexión CDP a medias y el perfil de AdsPower
      // tomado. Un proceso nuevo cuesta dos segundos; adivinar qué quedó a
      // medio camino, mucho más. PM2 lo levanta por `autorestart`.
      console.error("[worker] tarea colgada: me reinicio para soltar el navegador");
      process.exit(1);
    }
  }
}

/**
 * Cierra UNA ventana de tres días pendiente del resumen ejecutivo.
 *
 * Una por pasada y no todas las que falten: el brief corre con razonamiento
 * profundo sobre cientos de menciones, y un proyecto recién importado con
 * meses de historial dispararía decenas de llamadas seguidas apenas arranca el
 * worker. Como la ingesta vuelve a pasar por acá cada vez que el proyecto
 * vence su intervalo, el atraso se drena solo sin picos de gasto.
 *
 * El error se registra y se traga: un informe que falla no debe cortar la
 * ingesta de los proyectos que siguen en la cola.
 */
async function closeDueBriefWindow(projectId: string) {
  try {
    const result = await generateNextBriefWindow(projectId);
    if (!result) return;
    console.log(
      `[escucha] ${projectId}: informe ${result.window.startDay} → ${result.window.endDay}` +
        ` (${result.window.mentions} menciones, quedan ${result.remaining})`,
    );
  } catch (err) {
    console.error(`[escucha] error al generar el informe de ${projectId}:`, err);
  }
}

/** Ingesta de los proyectos de escucha cuyo intervalo ya venció. */
async function listeningTick() {
  if (Date.now() - lastListeningCheck < LISTENING_CHECK_MS) return;
  lastListeningCheck = Date.now();

  const due = await findDueProjects();

  for (const projectId of due) {
    if (stopping) return;

    try {
      const report = await ingestProject(projectId);
      console.log(
        `[escucha] ${projectId}: ${report.saved} nuevas de ${report.fetched} traídas` +
          `${report.errors.length > 0 ? ` (${report.errors.length} fuentes con error)` : ""}`,
      );

      const project = await ListeningProjectModel.findById(projectId)
        .select("autoAnalyze autoBrief")
        .lean();
      if (project?.autoAnalyze && report.saved > 0) {
        // Si falta la API key de Claude esto tira; se registra y la ingesta
        // igual queda guardada, que es lo que importa preservar.
        const analyzed = await analyzeMentions(projectId);
        console.log(`[escucha] ${projectId}: ${analyzed} menciones analizadas`);
      }

      if (project?.autoBrief !== false) await closeDueBriefWindow(projectId);
    } catch (err) {
      console.error(`[escucha] error en el proyecto ${projectId}:`, err);
    }
  }
}

/**
 * Devuelve al ruedo las tareas que quedaron en "running" sin nadie corriéndolas.
 *
 * `tick` marca la tarea como "running" al tomarla, así que todo lo que mate al
 * worker a mitad de camino —un `pm2 restart`, un reinicio del VPS, el suicidio
 * por tarea colgada de acá arriba— deja esa tarea marcada como si siguiera
 * ejecutándose. Nadie la vuelve a mirar: el worker solo levanta "queued". Antes
 * de esto había que relanzarlas a mano desde el modal de la campaña, sabiendo
 * primero que existían.
 *
 * Corre una sola vez, al arrancar, y solo con el rol de tareas encendido.
 */
async function recuperarHuerfanas() {
  // Si hay OTRO worker de tareas latiendo, las "running" son suyas y están de
  // verdad corriendo: devolverlas a la cola las haría ejecutarse dos veces.
  const otro = await WorkerHeartbeatModel.findById("tasks").lean();
  if (otro && otro.host !== HOST && Date.now() - new Date(otro.updatedAt).getTime() <= otro.pollIntervalMs * 3) {
    console.warn(`[worker] ${otro.host} ya está tomando tareas: no toco las huérfanas`);
    return;
  }

  const huerfanas = await TaskModel.find({ status: "running" }).select("campaignId").lean();
  if (huerfanas.length === 0) return;

  // Una campaña pausada mientras una de sus tareas corría queda con el resto en
  // "paused" y esa sola en "running" (pausar no interrumpe un browser a media
  // acción, a propósito). Mandarla a la cola reanudaría sola una campaña que el
  // usuario detuvo, así que vuelve a la pausa con el resto.
  const campañas = huerfanas.map((t) => t.campaignId).filter(Boolean);
  const pausadas = new Set(
    (await TaskModel.distinct("campaignId", { campaignId: { $in: campañas }, status: "paused" })).map(String),
  );
  const enPausa = (t: (typeof huerfanas)[number]) => Boolean(t.campaignId) && pausadas.has(String(t.campaignId));

  const aEncolar = huerfanas.filter((t) => !enPausa(t)).map((t) => t._id);
  const aPausar = huerfanas.filter(enPausa).map((t) => t._id);

  if (aEncolar.length > 0) {
    await TaskModel.updateMany(
      { _id: { $in: aEncolar } },
      { $set: { status: "queued" }, $unset: { startedAt: 1 } },
    );
  }
  if (aPausar.length > 0) {
    await TaskModel.updateMany(
      { _id: { $in: aPausar } },
      { $set: { status: "paused", resumeStatus: "queued" }, $unset: { startedAt: 1 } },
    );
  }

  console.log(
    `[worker] ${aEncolar.length} tareas huérfanas devueltas a la cola` +
      (aPausar.length > 0 ? ` y ${aPausar.length} a su campaña pausada` : ""),
  );
}

async function main() {
  if (ROLES.length === 0) {
    console.error("[worker] WORKER_TASKS y WORKER_LISTENING están los dos apagados: no hay nada que hacer");
    process.exit(1);
  }

  await dbConnect();
  console.log(
    `[worker] ${HOST} · roles: ${ROLES.join(" + ")} · poll cada ${POLL_INTERVAL_MS}ms`,
  );

  // Antes del primer latido: `recuperarHuerfanas` mira el latido de "tasks"
  // para no pisar a otro worker, y si ya escribimos el nuestro estaríamos
  // comparándonos contra nosotros mismos.
  if (ROLES.includes("tasks")) {
    await recuperarHuerfanas().catch((err) =>
      console.error("[worker] no se pudieron recuperar las tareas huérfanas:", err),
    );
  }

  // El latido va en su propio temporizador, no dentro del bucle de trabajo.
  //
  // Latir una vez por vuelta parecía suficiente, pero `tick()` ejecuta una
  // tarea entera —abrir el navegador en AdsPower, navegar, publicar, cerrar—,
  // y eso tarda bastante más que los tres intervalos que la web usa para dar
  // el worker por vivo. Resultado: el chip de la barra superior pasaba a "SOLO
  // ESCUCHA" cada vez que había una tarea corriendo, es decir, justo cuando el
  // worker estaba más ocupado, y volvía a "EN VIVO" al terminar.
  await heartbeat();
  const latido = setInterval(() => {
    heartbeat().catch((err) => console.error("[worker] latido falló:", err));
  }, POLL_INTERVAL_MS);

  try {
    while (!stopping) {
      if (ROLES.includes("tasks")) await tick();
      if (ROLES.includes("listening")) await listeningTick();
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  } finally {
    clearInterval(latido);
  }

  console.log("[worker] detenido");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] error fatal:", err);
  process.exit(1);
});
