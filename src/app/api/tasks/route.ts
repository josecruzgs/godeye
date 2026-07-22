import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import { withApiErrors } from "@/lib/apiHandler";
import { escapeRegex } from "@/lib/regex";

export const GET = withApiErrors(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  const type = sp.get("type") ?? undefined;
  const profileId = sp.get("profileId") ?? undefined;
  const search = sp.get("search")?.trim();
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || 20));

  await dbConnect();

  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (type) filter.type = type;
  if (profileId) filter.profileId = profileId;
  if (search) filter.name = { $regex: escapeRegex(search), $options: "i" };

  const [tasks, total] = await Promise.all([
    TaskModel.find(filter)
      .populate("profileId", "name adsPowerProfileId")
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    TaskModel.countDocuments(filter),
  ]);

  return NextResponse.json({ tasks, total, page, pageSize });
});

export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  if (!body.name || !body.profileId) {
    return NextResponse.json({ error: "'name' y 'profileId' son requeridos" }, { status: 400 });
  }

  await dbConnect();
  const task = await TaskModel.create({
    name: body.name,
    profileId: body.profileId,
    type: body.type ?? "custom",
    steps: body.steps ?? [],
    status: "pending",
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : new Date(),
  });

  return NextResponse.json({ task }, { status: 201 });
});
