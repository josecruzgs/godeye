import { NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { withApiErrors } from "@/lib/apiHandler";

// Lista de etiquetas distintas en uso (para poblar el filtro) — no la
// paginada de perfiles, que solo trae las de la página visible.
export const GET = withApiErrors(async () => {
  await dbConnect();
  const tags = await ProfileModel.aggregate([
    { $unwind: "$tags" },
    { $group: { _id: "$tags.name", color: { $first: "$tags.color" } } },
    { $project: { _id: 0, name: "$_id", color: 1 } },
    { $sort: { name: 1 } },
  ]);
  return NextResponse.json({ tags });
});
