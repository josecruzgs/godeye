import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";
import { withAuth } from "@/lib/apiHandler";

// Pausa una campaña: las tareas "pending"/"queued" pasan a "paused" (el
// worker solo levanta tareas "queued", así que esto alcanza para que deje
// de tocarlas). Las que ya están "running" siguen hasta terminar — no hay
// forma segura de interrumpir un browser a mitad de un step.
export const POST = withAuth(
  async (user, _req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const campaign = await CampaignModel.findOne({ _id: id, ownerId: user.objectId }).select("_id").lean();
    if (!campaign) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const result = await TaskModel.updateMany({ campaignId: id, status: { $in: ["pending", "queued"] } }, [
      { $set: { resumeStatus: "$status", status: "paused" } },
    ]);

    return NextResponse.json({ pausedCount: result.modifiedCount });
  },
);
