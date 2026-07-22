import { config } from "dotenv";
config({ path: ".env.local" });

import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import WorkerHeartbeatModel from "@/lib/models/WorkerHeartbeat";
import { runTask } from "@/lib/automation/runner";

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);

let stopping = false;
process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));

async function heartbeat() {
  await WorkerHeartbeatModel.findByIdAndUpdate(
    "singleton",
    { $set: { pollIntervalMs: POLL_INTERVAL_MS } },
    { upsert: true },
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
    await runTask(String(task._id));
  } catch (err) {
    console.error(`[worker] error en tarea ${task._id}:`, err);
  }
}

async function main() {
  await dbConnect();
  console.log(`[worker] conectado a MongoDB, poll cada ${POLL_INTERVAL_MS}ms`);

  while (!stopping) {
    await heartbeat();
    await tick();
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  console.log("[worker] detenido");
  process.exit(0);
}

main().catch((err) => {
  console.error("[worker] error fatal:", err);
  process.exit(1);
});
