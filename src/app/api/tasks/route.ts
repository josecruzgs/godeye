import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
// Registra el schema de "Profile" para que TaskModel.populate("profileId")
// no truene con "Schema hasn't been registered" en un lambda frío que nunca
// cargó /api/profiles antes.
import "@/lib/models/Profile";
import { withAuth } from "@/lib/apiHandler";
import { isAdmin } from "@/lib/auth/dal";
import { findUsableProfile } from "@/lib/auth/profiles";
import { filtroDeTareas } from "@/lib/tasks/filtroDeTareas";

export const GET = withAuth(async (user, req: NextRequest) => {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? undefined;
  const type = sp.get("type") ?? undefined;
  const profileId = sp.get("profileId") ?? undefined;
  const search = sp.get("search")?.trim();
  const ownerId = sp.get("ownerId") ?? undefined;
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(sp.get("pageSize")) || 20));

  await dbConnect();

  const filter = filtroDeTareas(user, { status, type, profileId, ownerId, search });

  // El dueño solo viaja cuando mira el admin: para un operador todas las
  // filas son suyas y el nombre sobraría en cada una.
  const query = TaskModel.find(filter).populate("profileId", "name adsPowerProfileId");
  if (isAdmin(user)) query.populate("ownerId", "username");

  const [tasks, total] = await Promise.all([
    query
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize),
    TaskModel.countDocuments(filter),
  ]);

  return NextResponse.json({ tasks, total, page, pageSize });
});

export const POST = withAuth(async (user, req: NextRequest) => {
  const body = await req.json();
  if (!body.name || !body.profileId) {
    return NextResponse.json({ error: "'name' y 'profileId' son requeridos" }, { status: 400 });
  }

  await dbConnect();
  // Corta con 404 si el perfil no existe o cae fuera de los grupos permitidos.
  const profile = await findUsableProfile(user, String(body.profileId));

  const task = await TaskModel.create({
    ownerId: user.objectId,
    name: body.name,
    profileId: profile._id,
    type: body.type ?? "custom",
    steps: body.steps ?? [],
    status: "pending",
    scheduledAt: body.scheduledAt ? new Date(body.scheduledAt) : new Date(),
  });

  return NextResponse.json({ task }, { status: 201 });
});
