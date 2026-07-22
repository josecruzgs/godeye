import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import WorkerHeartbeatModel from "@/lib/models/WorkerHeartbeat";
import { withApiErrors } from "@/lib/apiHandler";

// El worker (src/worker/index.ts) escribe un latido en cada tick. Si no hay
// uno reciente (más de 3 intervalos de poll), lo consideramos caído.
export const GET = withApiErrors(async () => {
  await dbConnect();
  const heartbeat = await WorkerHeartbeatModel.findById("singleton");

  if (!heartbeat) {
    return NextResponse.json({ online: false, lastSeenAt: null });
  }

  const ageMs = Date.now() - new Date(heartbeat.updatedAt).getTime();
  const online = ageMs <= heartbeat.pollIntervalMs * 3;

  return NextResponse.json({ online, lastSeenAt: heartbeat.updatedAt, ageMs });
});
