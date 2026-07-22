import { NextRequest, NextResponse } from "next/server";
import { dbConnect } from "@/lib/mongodb";
import PostModel from "@/lib/models/Post";
import { parseCsv } from "@/lib/csv";
import { withApiErrors } from "@/lib/apiHandler";

export const GET = withApiErrors(async (req: NextRequest) => {
  const usedParam = req.nextUrl.searchParams.get("used");
  const limit = Number(req.nextUrl.searchParams.get("limit")) || 0;

  await dbConnect();
  const filter = usedParam === "true" ? { used: true } : usedParam === "false" ? { used: false } : {};

  let query = PostModel.find(filter).sort({ createdAt: 1 });
  if (limit > 0) query = query.limit(limit);
  const posts = await query;

  const [total, available] = await Promise.all([
    PostModel.countDocuments({}),
    PostModel.countDocuments({ used: false }),
  ]);

  return NextResponse.json({ posts, total, available, used: total - available });
});

// Importa publicaciones desde un Sheet publicado como CSV ("Archivo > Compartir
// > Publicar en la web" en Google Sheets, formato CSV) o desde una lista
// pegada a mano. Se toma la primera columna de cada fila como el texto.
export const POST = withApiErrors(async (req: NextRequest) => {
  const body = await req.json();
  await dbConnect();

  let texts: string[] = [];
  let source = "manual";

  if (typeof body.sheetUrl === "string" && body.sheetUrl.trim()) {
    source = body.sheetUrl.trim();
    const res = await fetch(source);
    if (!res.ok) {
      return NextResponse.json(
        { error: `No se pudo leer el Sheet (HTTP ${res.status}). ¿Está publicado como CSV?` },
        { status: 400 },
      );
    }
    const csv = await res.text();
    // El link de "Publicar en la web" puede quedar en formato "Página web"
    // (HTML) en vez de "Valores separados por comas (.csv)" si no se cambió
    // el desplegable de formato. Si eso pasa, cada línea del HTML se
    // importaría como una "publicación" — se detecta y se rechaza antes.
    if (/^\s*<(!doctype html|html)/i.test(csv)) {
      return NextResponse.json(
        {
          error:
            "El link devolvió HTML, no CSV. En 'Publicar en la web' cambia el desplegable de formato a 'Valores separados por comas (.csv)' antes de copiar el link (debe terminar en algo como '/pub?output=csv').",
        },
        { status: 400 },
      );
    }
    texts = parseCsv(csv)
      .map((row) => (row[0] ?? "").trim())
      .filter(Boolean);
  } else if (Array.isArray(body.posts)) {
    texts = body.posts.map((t: unknown) => String(t).trim()).filter(Boolean);
  }

  if (texts.length === 0) {
    return NextResponse.json({ error: "No se encontraron publicaciones para importar" }, { status: 400 });
  }

  // Evita duplicados exactos que ya estén en el banco (de cualquier origen).
  const existing = new Set((await PostModel.find({ text: { $in: texts } }).select("text")).map((c) => c.text));
  const fresh = texts.filter((t) => !existing.has(t));

  if (fresh.length > 0) {
    await PostModel.insertMany(fresh.map((text) => ({ text, source })));
  }

  const [total, available] = await Promise.all([
    PostModel.countDocuments({}),
    PostModel.countDocuments({ used: false }),
  ]);

  return NextResponse.json({ imported: fresh.length, skipped: texts.length - fresh.length, total, available });
});

// Vacía el banco por completo (a diferencia de /reset-used, esto borra los
// documentos en vez de solo volver a marcarlos como disponibles).
export const DELETE = withApiErrors(async () => {
  await dbConnect();
  await PostModel.deleteMany({});
  return NextResponse.json({ ok: true, total: 0, available: 0 });
});
