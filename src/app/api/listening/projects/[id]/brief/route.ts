import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/apiHandler";
import { buildExecutiveBrief } from "@/lib/listening/analyze";
import { parseDayRange } from "@/lib/listening/range";

type Params = { params: Promise<{ id: string }> };

export const POST = withApiErrors(async (req: NextRequest, { params }: Params) => {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const { from, to } = parseDayRange(body.from ?? null, body.to ?? null);

  const brief = await buildExecutiveBrief(id, from, to);
  return NextResponse.json({ brief, range: { from, to } });
});
