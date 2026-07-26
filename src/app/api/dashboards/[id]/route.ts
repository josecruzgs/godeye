import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import DashboardModel from "@/lib/models/Dashboard";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const dashboard = await DashboardModel.findById(id).lean();
    if (!dashboard) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    return NextResponse.json({
      _id: dashboard._id,
      name: dashboard.name,
      token: dashboard.token,
      campaignIds: (dashboard.campaignIds ?? []).map(String),
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
    });
  },
);

export const PATCH = withApiErrors(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    const body = await req.json();

    const update: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) return NextResponse.json({ error: "El nombre del dashboard es obligatorio" }, { status: 400 });
      update.name = name;
    }
    if (Array.isArray(body.campaignIds)) {
      update.campaignIds = body.campaignIds.filter((cid: unknown) => typeof cid === "string");
    }

    await dbConnect();

    const dashboard = await DashboardModel.findByIdAndUpdate(id, update, { new: true }).lean();
    if (!dashboard) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    return NextResponse.json({
      _id: dashboard._id,
      name: dashboard.name,
      token: dashboard.token,
      campaignIds: (dashboard.campaignIds ?? []).map(String),
      createdAt: dashboard.createdAt,
      updatedAt: dashboard.updatedAt,
    });
  },
);

export const DELETE = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();

    const dashboard = await DashboardModel.findByIdAndDelete(id).select("_id").lean();
    if (!dashboard) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    return NextResponse.json({ deletedDashboardId: id });
  },
);
