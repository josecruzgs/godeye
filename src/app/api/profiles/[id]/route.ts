import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { adsPower } from "@/lib/adspower/client";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    const profile = await ProfileModel.findById(id);
    if (!profile) return NextResponse.json({ error: "No encontrado" }, { status: 404 });
    return NextResponse.json({ profile });
  },
);

export const DELETE = withApiErrors(
  async (_req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params;
    await dbConnect();
    const profile = await ProfileModel.findById(id);
    if (!profile) return NextResponse.json({ error: "No encontrado" }, { status: 404 });

    await adsPower.deleteProfiles([profile.adsPowerProfileId]);
    await profile.deleteOne();

    return NextResponse.json({ ok: true });
  },
);
