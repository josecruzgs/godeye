import { NextResponse, type NextRequest } from "next/server";
import { cuestionarioActivo, resultadosLlamadas } from "@/lib/encuestas/llamadas";
import { noAutorizado } from "@/lib/encuestas/integracion";

/** GET /api/encuestas/v1/resultados — los resultados de la encuesta activa (sin pruebas; ?pruebas=1 las incluye y lo dice). */
export async function GET(req: NextRequest) {
  const cerrado = noAutorizado(req);
  if (cerrado) return cerrado;
  const c = await cuestionarioActivo();
  if (!c) return NextResponse.json({ ok: false, error: "No hay encuesta activa." }, { status: 404 });
  const r = await resultadosLlamadas(c, { conPruebas: req.nextUrl.searchParams.get("pruebas") === "1" });
  return NextResponse.json({
    ok: true,
    encuesta: c.nombre, version: c.version, conPruebas: r.conPruebas, pruebas: r.pruebas,
    llamadas: { hechas: r.intentos, contestaron: r.contestaron, completas: r.completas, duracionMediaSeg: r.duracionMedia, porEstado: r.porEstado },
    preguntas: r.preguntas.map((q) => ({ clave: q.pregunta.clave, texto: q.pregunta.texto, respondieron: q.respondieron, opciones: q.filas.map((f) => ({ opcion: f.nombre, n: f.votos, pct: f.pct })) })),
  });
}
