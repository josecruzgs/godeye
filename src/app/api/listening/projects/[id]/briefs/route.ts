import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ExecutiveBriefModel from "@/lib/models/ExecutiveBrief";
import { withApiErrors } from "@/lib/apiHandler";

type Params = { params: Promise<{ id: string }> };

/** Historial de resúmenes ejecutivos del proyecto, del más nuevo al más viejo. */
export const GET = withApiErrors(async (req: NextRequest, { params }: Params) => {
  const { id } = await params;
  const limit = Math.min(50, Math.max(1, Number(req.nextUrl.searchParams.get("limit")) || 20));

  await dbConnect();
  const briefs = await ExecutiveBriefModel.find({ projectId: id })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return NextResponse.json({ briefs });
});

export const DELETE = withApiErrors(async (req: NextRequest, { params }: Params) => {
  const { id } = await params;
  const briefId = req.nextUrl.searchParams.get("briefId");
  if (!briefId) return NextResponse.json({ error: "Falta briefId" }, { status: 400 });

  await dbConnect();
  await ExecutiveBriefModel.deleteOne({ _id: briefId, projectId: id });

  return NextResponse.json({ ok: true });
});
