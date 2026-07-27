import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import TaskLogModel from "@/lib/models/TaskLog";
// Registra el schema de "Profile" para que TaskModel.populate("profileId")
// no truene con "Schema hasn't been registered" en un lambda frío que nunca
// cargó /api/profiles antes.
import "@/lib/models/Profile";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    const task = await TaskModel.findById(id).populate("profileId", "name adsPowerProfileId");
    if (!task) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const logs = await TaskLogModel.find({ taskId: id }).sort({ createdAt: 1 });
    return NextResponse.json({ task, logs });
  },
);

export const DELETE = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    await TaskModel.findByIdAndDelete(id);
    await TaskLogModel.deleteMany({ taskId: id });
    return NextResponse.json({ ok: true });
  },
);
