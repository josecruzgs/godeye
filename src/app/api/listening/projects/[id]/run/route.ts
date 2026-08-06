import { NextRequest, NextResponse } from "next/server";
import { withApiErrors } from "@/lib/apiHandler";
import { ingestProject } from "@/lib/listening/ingest";
import { analyzeMentions } from "@/lib/listening/analyze";
import ListeningProjectModel from "@/lib/models/ListeningProject";
import { dbConnect } from "@/lib/mongodb";

type Params = { params: Promise<{ id: string }> };

/** Corrida manual: trae menciones nuevas y, si el proyecto lo pide, las analiza. */
export const POST = withApiErrors(async (_req: NextRequest, { params }: Params) => {
  const { id } = await params;

  const report = await ingestProject(id);

  await dbConnect();
  const project = await ListeningProjectModel.findById(id).select("autoAnalyze").lean();

  let analyzed = 0;
  let analysisError: string | null = null;

  if (project?.autoAnalyze) {
    // El análisis falla si falta la API key de Claude. Eso no debe hacer
    // fallar la ingesta, que ya trajo datos útiles.
    try {
      analyzed = await analyzeMentions(id);
    } catch (err) {
      analysisError = err instanceof Error ? err.message : String(err);
    }
  }

  return NextResponse.json({ report, analyzed, analysisError });
});
