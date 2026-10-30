import { NextResponse, type NextRequest } from "next/server";
import { llamarConAgente } from "@/lib/encuestas/agente_voz";
import { celularValido } from "@/lib/encuestas/base";
import { noAutorizado, frenoPorNumero } from "@/lib/encuestas/integracion";

/**
 * POST /api/encuestas/v1/llamar — la asistente llama a ese número y le hace la encuesta activa.
 * Cuerpo: { "telefono": "6641234567", "prueba": false }
 * Responde 202 con el id de la llamada; el resultado se consulta en GET /api/encuestas/v1/llamadas/{id} cuando cuelga.
 * Una llamada real respeta el horario y a quien pidió que no le llamen; «prueba» sale a cualquier hora y no cuenta en resultados.
 */
export async function POST(req: NextRequest) {
  const cerrado = noAutorizado(req);
  if (cerrado) return cerrado;
  const cuerpo = (await req.json().catch(() => null)) as { telefono?: unknown; prueba?: unknown } | null;
  const diez = celularValido(typeof cuerpo?.telefono === "string" || typeof cuerpo?.telefono === "number" ? String(cuerpo.telefono) : "");
  if (!diez) return NextResponse.json({ ok: false, error: "«telefono» debe ser un celular de México de 10 dígitos." }, { status: 400 });
  const freno = await frenoPorNumero(diez);
  if (freno) return NextResponse.json({ ok: false, error: freno }, { status: 429 });
  const r = await llamarConAgente(diez, { prueba: cuerpo?.prueba === true });
  if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 422 });
  return NextResponse.json({ ok: true, llamadaId: r.llamadaId, numero: r.numero, prueba: cuerpo?.prueba === true, estado: "EN_CURSO" }, { status: 202 });
}
