import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";
import { withApiErrors } from "@/lib/apiHandler";

// Reanuda una campaña pausada: las tareas "paused" vuelven al estado que
// tenían antes de pausarse (resumeStatus), sin tocar scheduledAt — si ya
// había pasado, el worker la vuelve a levantar en el próximo tick.
export const POST = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const campaign = await CampaignModel.findById(id).select("_id").lean();
    if (!campaign) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const result = await TaskModel.updateMany({ campaignId: id, status: "paused" }, [
      { $set: { status: { $ifNull: ["$resumeStatus", "queued"] } } },
      { $unset: "resumeStatus" },
    ]);

    return NextResponse.json({ resumedCount: result.modifiedCount });
  },
);
