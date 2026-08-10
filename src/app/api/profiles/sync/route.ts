import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import ProfileModel from "@/lib/models/Profile";
import { adsPower } from "@/lib/adspower/client";
import { withAdmin } from "@/lib/apiHandler";
import { parseRemark } from "@/lib/remark";

// AdsPower no tiene un concepto de "plataforma" en su API — lo inferimos
// del dominio que el perfil tenía abierto la última vez, cuando está
// disponible. Si no matchea nada conocido, se deja como está (no se borra
// un valor puesto a mano).
function inferPlatform(domainName?: string): string {
  const d = (domainName ?? "").toLowerCase();
  if (d.includes("facebook")) return "facebook";
  if (d.includes("instagram")) return "instagram";
  if (d.includes("tiktok")) return "tiktok";
  if (d.includes("twitter") || d.includes("x.com")) return "x";
  if (d.includes("linkedin")) return "linkedin";
  return "";
}

// Trae los perfiles desde AdsPower y sincroniza (upsert) en Mongo.
//
// Solo admin: además de escribir la tabla compartida, BORRA todo perfil que
// AdsPower no haya devuelto (ver más abajo). Con una cuenta de AdsPower que
// vea de menos, eso vacía perfiles de grupos ajenos.
export const POST = withAdmin(async (_user, req: NextRequest) => {
  const groupId = req.nextUrl.searchParams.get("groupId") ?? undefined;

  await dbConnect();
  const list = await adsPower.listAllProfiles(groupId);

  for (const p of list) {
    const remark = p.remark ?? "";
    const { age, gender } = parseRemark(remark);
    const tags = (p.fbcc_user_tag ?? []).map((t) => ({ name: t.name, color: t.color }));
    const update: Record<string, unknown> = { name: p.name, groupId: p.group_id, remark, age, gender, tags };
    const inferredPlatform = inferPlatform(p.domain_name);
    if (inferredPlatform) update.platform = inferredPlatform;

    await ProfileModel.updateOne({ adsPowerProfileId: p.user_id }, { $set: update }, { upsert: true });
  }

  // AdsPower es la fuente de verdad: cualquier perfil que ya no aparezca ahi
  // (borrado, renombrado de user_id, etc.) se elimina tambien de Mongo para
  // que /profiles no muestre perfiles fantasma.
  const currentIds = list.map((p) => p.user_id);
  const staleFilter: Record<string, unknown> = { adsPowerProfileId: { $nin: currentIds } };
  if (groupId) staleFilter.groupId = groupId;
  const { deletedCount } = await ProfileModel.deleteMany(staleFilter);

  const profiles = await ProfileModel.find(groupId ? { groupId } : {}).sort({ name: 1 });
  return NextResponse.json({ profiles, removed: deletedCount ?? 0 });
});
