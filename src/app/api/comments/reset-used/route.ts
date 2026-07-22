import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import CommentModel from "@/lib/models/Comment";
import { withApiErrors } from "@/lib/apiHandler";

// Vuelve a marcar todo el banco como disponible. Útil si quieres reciclar
// la misma lista de comentarios en otra ronda.
export const POST = withApiErrors(async () => {
  await dbConnect();
  await CommentModel.updateMany({}, { $set: { used: false }, $unset: { usedAt: "", usedByTaskId: "" } });
  const total = await CommentModel.countDocuments({});
  return NextResponse.json({ total, available: total });
});
