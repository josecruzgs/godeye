import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/apiHandler";
import { analyzeMentions } from "@/lib/listening/analyze";

type Params = { params: Promise<{ id: string }> };

/** Clasifica con Claude las menciones que quedaron sin analizar. */
export const POST = withApiErrors(async (req: NextRequest, { params }: Params) => {
  const { id } = await params;
  // ?reanalyze=1 vuelve a juzgar TODO, no solo lo pendiente.
  const reanalyze = req.nextUrl.searchParams.get("reanalyze") === "1";
  const analyzed = await analyzeMentions(id, reanalyze ? 1000 : 200, { reanalyze });
  return NextResponse.json({ analyzed });
});
