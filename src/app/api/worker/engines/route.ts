import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import WorkerConfigModel from "@/lib/models/WorkerConfig";
import { withAuth, HttpError } from "@/lib/apiHandler";
import { isAdmin } from "@/lib/auth/dal";
import { MOTORES_TOTALES } from "@/lib/motores";

/**
 * Cuántos motores tiene encendidos el worker de tareas.
 *
 * Solo el admin: es capacidad de la máquina compartida —cada motor es un
 * navegador más en AdsPower sobre el VPS—, no una preferencia de quien mira.
 *
 * El worker lo relee en cada latido (unos segundos); el número que la sala
 * muestra como encendido sigue saliendo del latido, así que la pantalla solo
 * cambia cuando el worker de verdad lo aplicó.
 */
export const PUT = withAuth(async (user, req: NextRequest) => {
  if (!isAdmin(user)) throw new HttpError(403, "Solo un admin puede cambiar los motores");

  const body = await req.json();
  const n = Number(body.engines);
  if (!Number.isInteger(n) || n < 1 || n > MOTORES_TOTALES) {
    throw new HttpError(400, `Los motores van de 1 a ${MOTORES_TOTALES}`);
  }

  await dbConnect();
  await WorkerConfigModel.findByIdAndUpdate("tasks", { $set: { engines: n } }, { upsert: true });

  return NextResponse.json({ engines: n });
});
