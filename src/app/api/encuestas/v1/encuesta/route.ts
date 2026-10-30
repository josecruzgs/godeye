import { NextResponse, type NextRequest } from "next/server";
import { cuestionarioActivo, leerOpciones } from "@/lib/encuestas/llamadas";
import { hayAgenteDeVoz, horarioDeLlamadas } from "@/lib/encuestas/agente_voz";
import { noAutorizado } from "@/lib/encuestas/integracion";

/** GET /api/encuestas/v1/encuesta — la encuesta activa tal como la dice la asistente, y si ahorita se puede llamar. */
export async function GET(req: NextRequest) {
  const cerrado = noAutorizado(req);
  if (cerrado) return cerrado;
  const c = await cuestionarioActivo();
  if (!c) return NextResponse.json({ ok: false, error: "No hay encuesta activa." }, { status: 404 });
  const h = horarioDeLlamadas();
  return NextResponse.json({
    ok: true,
    nombre: c.nombre, version: c.version, saludo: c.saludo, cierre: c.cierre,
    preguntas: c.preguntas.map((p) => ({ clave: p.clave, texto: p.texto, opciones: leerOpciones(p.opciones), noSeLeen: leerOpciones(p.noSeLeen) })),
    agenteConectado: hayAgenteDeVoz(), horario: h.texto, enHorario: h.abierto,
  });
}
