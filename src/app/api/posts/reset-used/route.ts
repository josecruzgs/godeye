import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import PostModel from "@/lib/models/Post";
import { withApiErrors } from "@/lib/apiHandler";

// Vuelve a marcar todo el banco como disponible. Útil si quieres reciclar
// la misma lista de publicaciones en otra ronda.
export const POST = withApiErrors(async () => {
  await dbConnect();
  await PostModel.updateMany({}, { $set: { used: false }, $unset: { usedAt: "", usedByTaskId: "" } });
  const total = await PostModel.countDocuments({});
  return NextResponse.json({ total, available: total });
});
