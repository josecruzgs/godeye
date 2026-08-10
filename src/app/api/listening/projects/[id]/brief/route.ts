import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/apiHandler";
import { dbConnect } from "@/lib/mongodb";
import { assertOwnedProject } from "@/lib/listening/ownership";
import { buildExecutiveBrief } from "@/lib/listening/analyze";
import { parseDayRange } from "@/lib/listening/range";

type Params = { params: Promise<{ id: string }> };

export const POST = withAuth(async (user, req: NextRequest, { params }: Params) => {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  await dbConnect();
  await assertOwnedProject(user, id);

  const { from, to } = parseDayRange(body.from ?? null, body.to ?? null);

  const brief = await buildExecutiveBrief(id, from, to);
  return NextResponse.json({ brief, range: { from, to } });
});
