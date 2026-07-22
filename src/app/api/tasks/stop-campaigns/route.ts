import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import { withApiErrors } from "@/lib/apiHandler";

// "Parar campañas": borra toda tarea que todavía no arrancó (pending/queued).
// Las que ya están "running" siguen hasta terminar (el worker ya las tomó,
// no hay forma limpia de interrumpirlas a medio Playwright) — esto solo
// vacía lo que falta por correr, que es lo que definimos como "la cola".
export const POST = withApiErrors(async () => {
  await dbConnect();
  const result = await TaskModel.deleteMany({ status: { $in: ["pending", "queued"] } });
  return NextResponse.json({ deletedCount: result.deletedCount ?? 0 });
});
