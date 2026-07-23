import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CampaignModel from "@/lib/models/Campaign";
import TaskModel from "@/lib/models/Task";
import { withApiErrors } from "@/lib/apiHandler";

export const POST = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const campaign = await CampaignModel.findById(id);
    if (!campaign) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    const result = await TaskModel.updateMany(
      { campaignId: id, status: "pending" },
      { $set: { status: "queued" }, $unset: { error: "" } },
    );

    return NextResponse.json({ queuedCount: result.modifiedCount });
  },
);
