import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";
import { makeCampaignSummary, type TaskStatusCounts } from "@/lib/campaigns";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const campaign = await CampaignModel.findById(id).lean();
    if (!campaign) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const tasks = await TaskModel.find({ campaignId: id })
      .populate("profileId", "name adsPowerProfileId")
      .select("name type status profileId scheduledAt startedAt finishedAt error")
      .sort({ scheduledAt: 1, createdAt: 1 })
      .lean();

    const counts = tasks.reduce<TaskStatusCounts>((acc, task) => {
      acc[task.status] = (acc[task.status] ?? 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      campaign: makeCampaignSummary({ campaign, counts }),
      tasks,
    });
  },
);

export const DELETE = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const campaign = await CampaignModel.findById(id).select("_id").lean();
    if (!campaign) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const runningCount = await TaskModel.countDocuments({ campaignId: id, status: "running" });
    if (runningCount > 0) {
      return NextResponse.json(
        { error: "No se puede eliminar una campaña con tareas corriendo" },
        { status: 409 },
      );
    }

    const taskResult = await TaskModel.deleteMany({ campaignId: id });
    await CampaignModel.deleteOne({ _id: id });

    return NextResponse.json({
      deletedCampaignId: id,
      deletedTaskCount: taskResult.deletedCount,
    });
  },
);
