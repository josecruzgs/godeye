import { NextRequest, NextResponse } from "next/server";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/mongodb";
import TaskModel from "@/lib/models/Task";
import ProfileModel, { type Profile } from "@/lib/models/Profile";
import { parseCsv } from "@/lib/csv";
import { withApiErrors } from "@/lib/apiHandler";
import { loginIfNeededSteps } from "@/lib/automation/loginSteps";

type SheetRow = { profileName: string; name: string; city: string };
type Step = { action: string; selector?: string; value?: string; url?: string; key?: string; ms?: number; optional?: boolean };
type Fields = { name?: string; city?: string };
type Selectors = {
  profileEditUrl: string;
  nameFieldSelector: string;
  cityOpenSelector: string;
  cityFieldSelector: string;
  saveSelector: string;
};
type ProfileDoc = Profile & { _id: Types.ObjectId };

// El Sheet trae una fila por perfil: Perfil (debe matchear el nombre exacto
// de un perfil existente), Nombre, Ciudad. Cualquier columna puede quedar
// vacía — solo se toca lo que venga con valor. Se asume la primera fila
// como encabezado.
async function fetchSheetRows(sheetUrl: string): Promise<SheetRow[]> {
  const res = await fetch(sheetUrl);
  if (!res.ok) {
    throw new Error(`No se pudo leer el Sheet (HTTP ${res.status}). ¿Está publicado como CSV?`);
  }
  const csv = await res.text();
  if (/^\s*<(!doctype html|html)/i.test(csv)) {
    throw new Error(
      "El link devolvió HTML, no CSV. En 'Publicar en la web' cambia el desplegable de formato a 'Valores separados por comas (.csv)' antes de copiar el link.",
    );
  }
  const [, ...body] = parseCsv(csv);
  return body
    .map((r) => ({
      profileName: (r[0] ?? "").trim(),
      name: (r[1] ?? "").trim(),
      city: (r[2] ?? "").trim(),
    }))
    .filter((r) => r.profileName);
}

// Arma los steps para un perfil a partir de los campos que traiga con valor
// (name/city) — cualquiera que falte simplemente no se toca. Comparte esta
// lógica tanto el modo "sheet" como el modo "manual".
function buildStepsForProfile(fields: Fields, selectors: Selectors, waitMs: number): Step[] {
  const steps: Step[] = [
    { action: "goto", url: selectors.profileEditUrl },
    { action: "waitForTimeout", ms: waitMs },
    ...loginIfNeededSteps(),
  ];

  if (fields.name && selectors.nameFieldSelector) {
    steps.push({ action: "click", selector: selectors.nameFieldSelector });
    steps.push({ action: "fill", selector: selectors.nameFieldSelector, value: fields.name });
    steps.push({ action: "waitForTimeout", ms: 500 });
  }

  if (fields.city && selectors.cityFieldSelector) {
    // Verificado en vivo: el campo de ciudad de Facebook es un combobox con
    // autocompletado, no un input plano — hay que abrir el flujo real
    // (Editar Datos personales → pencil de "Editar ciudad actual"), escribir
    // el texto, esperar la lista de sugerencias, y confirmar con
    // ArrowDown+Enter (eso ya guarda solo; el botón "Guardar" visible queda
    // deshabilitado justo después y no hace falta clickearlo).
    for (const openSel of selectors.cityOpenSelector.split("||").map((s) => s.trim()).filter(Boolean)) {
      steps.push({ action: "click", selector: openSel });
      steps.push({ action: "waitForTimeout", ms: 1500 });
    }
    steps.push({ action: "click", selector: selectors.cityFieldSelector });
    steps.push({ action: "press", selector: selectors.cityFieldSelector, key: "Control+a" });
    steps.push({ action: "type", selector: selectors.cityFieldSelector, value: fields.city });
    steps.push({ action: "waitForTimeout", ms: 1800 });
    steps.push({ action: "press", key: "ArrowDown" });
    steps.push({ action: "press", key: "Enter" });
    steps.push({ action: "waitForTimeout", ms: 1000 });
  }

  if (selectors.saveSelector) {
    steps.push({ action: "click", selector: selectors.saveSelector });
    steps.push({ action: "waitForTimeout", ms: 2000 });
  }

  return steps;
}

// Si un campo trae valor pero falta su selector, el step correspondiente se
// saltaría en silencio y la tarea terminaría "success" sin haber cambiado
// nada — se valida ANTES de crear tareas para no generar ese falso éxito.
function missingSelectorsFor(fieldsList: Fields[], selectors: Selectors): string[] {
  const missing = new Set<string>();
  for (const f of fieldsList) {
    if (f.name && !selectors.nameFieldSelector) missing.add("nombre");
    if (f.city && !selectors.cityFieldSelector) missing.add("ciudad");
  }
  return Array.from(missing);
}

function readSelectors(body: Record<string, unknown>): Selectors {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    profileEditUrl: str(body.profileEditUrl),
    nameFieldSelector: str(body.nameFieldSelector),
    cityOpenSelector: str(body.cityOpenSelector),
    cityFieldSelector: str(body.cityFieldSelector),
    saveSelector: str(body.saveSelector),
  };
}

export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  const mode = body.mode === "manual" ? "manual" : "sheet";
  const dryRun = Boolean(body.dryRun);

  await dbConnect();

  // --- Modo sheet: leer y matchear filas contra perfiles existentes -------
  if (mode === "sheet") {
    const sheetUrl = typeof body.sheetUrl === "string" ? body.sheetUrl.trim() : "";
    if (!sheetUrl) {
      return NextResponse.json({ error: "'sheetUrl' es requerido" }, { status: 400 });
    }

    const rows = await fetchSheetRows(sheetUrl);
    if (rows.length === 0) {
      return NextResponse.json({ error: "El Sheet no tiene filas con la columna 'Perfil' llena" }, { status: 400 });
    }

    const profiles = await ProfileModel.find({});
    const byName = new Map(profiles.map((p) => [p.name.trim().toLowerCase(), p]));

    const matched = rows
      .map((row) => ({ row, profile: byName.get(row.profileName.trim().toLowerCase()) }))
      .filter((r): r is { row: SheetRow; profile: ProfileDoc } => Boolean(r.profile));
    const unmatchedNames = rows
      .filter((row) => !byName.has(row.profileName.trim().toLowerCase()))
      .map((row) => row.profileName);

    if (dryRun) {
      return NextResponse.json({
        matched: matched.map(({ row, profile }) => ({
          profileId: profile._id,
          profileName: profile.name,
          groupId: profile.groupId,
          platform: profile.platform,
          lastStatus: profile.lastStatus,
          age: profile.age ?? null,
          gender: profile.gender ?? null,
          name: row.name || null,
          city: row.city || null,
        })),
        unmatchedNames,
      });
    }

    const selectedProfileIds: string[] = Array.isArray(body.selectedProfileIds) ? body.selectedProfileIds : [];
    const selected = matched.filter(({ profile }) => selectedProfileIds.includes(String(profile._id)));
    if (selected.length === 0) {
      return NextResponse.json({ error: "No hay perfiles seleccionados para actualizar" }, { status: 400 });
    }

    const selectors = readSelectors(body);
    if (!selectors.profileEditUrl) {
      return NextResponse.json({ error: "'profileEditUrl' es requerido" }, { status: 400 });
    }

    const selectedFields = selected.map(({ row }) => ({ name: row.name || undefined, city: row.city || undefined }));
    const missing = missingSelectorsFor(selectedFields, selectors);
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Faltan selectores para: ${missing.join(", ")}. Complétalos en "Ver selectores y ajustes adicionales" antes de crear las tareas — si no, esos campos se saltarían sin avisar.`,
        },
        { status: 400 },
      );
    }

    const waitMs = Number(body.waitMs) > 0 ? Number(body.waitMs) : 3000;
    const staggerSeconds = Number(body.staggerSeconds) >= 0 ? Number(body.staggerSeconds) : 0;
    const autoRun = Boolean(body.autoRun);
    const namePrefix =
      typeof body.namePrefix === "string" && body.namePrefix.trim() ? body.namePrefix.trim() : "auto-profile";
    const now = Date.now();

    const docs = selected.map(({ row, profile }, i) => ({
      name: `${namePrefix} · ${profile.name}`,
      profileId: profile._id,
      type: "custom" as const,
      steps: buildStepsForProfile({ name: row.name || undefined, city: row.city || undefined }, selectors, waitMs),
      status: autoRun ? ("queued" as const) : ("pending" as const),
      scheduledAt: new Date(now + i * staggerSeconds * 1000),
    }));

    const created = await TaskModel.insertMany(docs);
    const tasks = created.map((t, i) => ({
      _id: t._id,
      name: t.name,
      status: t.status,
      profile: { _id: selected[i].profile._id, name: selected[i].profile.name },
    }));
    return NextResponse.json({ tasks }, { status: 201 });
  }

  // --- Modo manual: una tarea por perfil, campos elegidos uno por uno ------
  type Assignment = { profileId: string; name?: string; city?: string };
  const assignments: Assignment[] = Array.isArray(body.assignments) ? body.assignments : [];
  if (assignments.length === 0) {
    return NextResponse.json({ error: "No hay perfiles con algún campo asignado" }, { status: 400 });
  }

  const selectors = readSelectors(body);
  if (!selectors.profileEditUrl) {
    return NextResponse.json({ error: "'profileEditUrl' es requerido" }, { status: 400 });
  }

  const missing = missingSelectorsFor(assignments, selectors);
  if (missing.length > 0) {
    return NextResponse.json(
      {
        error: `Faltan selectores para: ${missing.join(", ")}. Complétalos en "Ver selectores y ajustes adicionales" antes de crear las tareas — si no, esos campos se saltarían sin avisar.`,
      },
      { status: 400 },
    );
  }

  const profileDocs = await ProfileModel.find({ _id: { $in: assignments.map((a) => a.profileId) } });
  const byId = new Map(profileDocs.map((p) => [String(p._id), p]));

  const waitMs = Number(body.waitMs) > 0 ? Number(body.waitMs) : 3000;
  const staggerSeconds = Number(body.staggerSeconds) >= 0 ? Number(body.staggerSeconds) : 0;
  const autoRun = Boolean(body.autoRun);
  const namePrefix =
    typeof body.namePrefix === "string" && body.namePrefix.trim() ? body.namePrefix.trim() : "auto-profile";
  const now = Date.now();

  const docs = [];
  const matchedProfiles: ProfileDoc[] = [];
  let i = 0;
  for (const a of assignments) {
    const profile = byId.get(a.profileId);
    if (!profile) continue;
    docs.push({
      name: `${namePrefix} · ${profile.name}`,
      profileId: profile._id,
      type: "custom" as const,
      steps: buildStepsForProfile({ name: a.name || undefined, city: a.city || undefined }, selectors, waitMs),
      status: autoRun ? ("queued" as const) : ("pending" as const),
      scheduledAt: new Date(now + i * staggerSeconds * 1000),
    });
    matchedProfiles.push(profile);
    i++;
  }

  if (docs.length === 0) {
    return NextResponse.json({ error: "No se encontraron los perfiles asignados" }, { status: 404 });
  }

  const created = await TaskModel.insertMany(docs);
  const tasks = created.map((t, idx) => ({
    _id: t._id,
    name: t.name,
    status: t.status,
    profile: { _id: matchedProfiles[idx]._id, name: matchedProfiles[idx].name },
  }));
  return NextResponse.json({ tasks }, { status: 201 });
});
