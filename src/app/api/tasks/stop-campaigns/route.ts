import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import { withAuth } from "@/lib/apiHandler";
import { allowedOwnerFilter, isAdmin } from "@/lib/auth/dal";

// "Parar campañas": borra toda tarea que todavía no arrancó (pending/queued).
// Las que ya están "running" siguen hasta terminar (el worker ya las tomó,
// no hay forma limpia de interrumpirlas a medio Playwright) — esto solo
// vacía lo que falta por correr, que es lo que definimos como "la cola".
//
// Al operador se le acota a lo suyo: es un botón de pánico, y sin el filtro le
// vaciaba la cola a todos los demás de un clic. El admin, en cambio, sí para
// todo el sistema: es lo que está mirando en la tabla y es quien tiene que
// poder frenar la automatización entera cuando algo se está saliendo de cauce.
// La interfaz se lo advierte antes de que confirme.
export const POST = withAuth(async (user) => {
  await dbConnect();
  const result = await TaskModel.deleteMany({
    ...allowedOwnerFilter(user),
    status: { $in: ["pending", "queued"] },
  });
  return NextResponse.json({ deletedCount: result.deletedCount ?? 0, scope: isAdmin(user) ? "all" : "mine" });
});
