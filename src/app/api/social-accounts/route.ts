import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import SocialAccountModel from "@/lib/models/SocialAccount";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(async (req: NextRequest) => {
  const profileId = req.nextUrl.searchParams.get("profileId") ?? undefined;
  await dbConnect();
  const accounts = await SocialAccountModel.find(profileId ? { profileId } : {}).sort({
    createdAt: -1,
  });
  return NextResponse.json({ accounts });
});

export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  if (!body.profileId || !body.platform || !body.username) {
    return NextResponse.json(
      { error: "'profileId', 'platform' y 'username' son requeridos" },
      { status: 400 },
    );
  }

  await dbConnect();
  const account = await SocialAccountModel.create({
    profileId: body.profileId,
    platform: body.platform,
    username: body.username,
    displayName: body.displayName ?? "",
    notes: body.notes ?? "",
    status: body.status ?? "unknown",
  });

  return NextResponse.json({ account }, { status: 201 });
});
