"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Types } from "mongoose";
import { dbConnect } from "@/lib/mongodb";
import EncuestaCuestionarioModel from "@/lib/models/EncuestaCuestionario";
import EncuestaLlamadaModel from "@/lib/models/EncuestaLlamada";
import EncuestaCambioModel from "@/lib/models/EncuestaCambio";
import { requireAdmin } from "@/lib/encuestas/acceso";
import { cuestionarioActivo, leerOpciones, type CuestionarioActivo } from "@/lib/encuestas/llamadas";
import { clavear } from "@/lib/encuestas/agente_voz";
import { leerFrases, sincronizarAgente, ROTULO_FRASES, type Frases } from "@/lib/encuestas/guion";

export type OpcionEditada = { original: string | null; texto: string; seLee: boolean };
export type PreguntaEditada = { id: string; texto: string; corto: string; reglas: string; opciones: OpcionEditada[] };
export type GuionEditado = { saludo: string; cierre: string; frases: Frases; preguntas: PreguntaEditada[] };
export type Resultado = { ok?: string; error?: string } | undefined;

const limpia = (x: unknown, max: number) => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const renglones = (x: unknown, max: number) => String(x ?? "").split("\n").map((l) => l.trim()).filter(Boolean).join("\n").slice(0, max);

/** Cuántas llamadas guardaron esa opción en esa pregunta. */
const conRespuesta = (preguntaId: string, valor: string) =>
  EncuestaLlamadaModel.countDocuments({ respuestas: { $elemMatch: { preguntaId: new Types.ObjectId(preguntaId), valor } } });

/** Cambia el valor guardado de una opción en todas las llamadas que la tienen. */
const renombrarRespuestas = (preguntaId: string, de: string, a: string) =>
  EncuestaLlamadaModel.updateMany(
    { respuestas: { $elemMatch: { preguntaId: new Types.ObjectId(preguntaId), valor: de } } },
    { $set: { "respuestas.$[r].valor": a } },
    { arrayFilters: [{ "r.preguntaId": new Types.ObjectId(preguntaId), "r.valor": de }] },
  );

/**
 * GUARDAR EL GUION. Primero se le manda a la asistente de voz y solo si ElevenLabs lo acepta se guarda en la base: así
 * nunca queda el tablero diciendo una cosa y la asistente otra. Cada guardado sube la versión y deja constancia de qué
 * cambió y quién lo cambió, porque cambiar una pregunta a media encuesta cambia lo que se mide.
 *
 * Las opciones conservan su historia: si se le cambia el nombre a una («Malo» → «Mal»), las respuestas que ya tenía pasan
 * al nombre nuevo. Una opción que ya tiene respuestas no se puede quitar (se puede renombrar).
 */
export async function guardarGuion(_prev: Resultado, formData: FormData): Promise<Resultado> {
  const s = await requireAdmin();
  let g: GuionEditado;
  try { g = JSON.parse(String(formData.get("datos") ?? "")); } catch { return { error: "No llegó el guion completo; recarga la página e inténtalo otra vez." }; }
  const c = await cuestionarioActivo();
  if (!c) return { error: "No hay cuestionario cargado." };

  const saludo = limpia(g.saludo, 400);
  const cierre = limpia(g.cierre, 300);
  if (saludo.length < 15) return { error: "La introducción quedó muy corta: tiene que decir quién llama y pedir permiso." };
  if (!cierre) return { error: "Falta la despedida." };
  const frases = leerFrases(null);
  for (const k of Object.keys(frases) as (keyof Frases)[]) {
    const v = limpia(g.frases?.[k], 300);
    if (!v) return { error: `Falta qué contesta la asistente «${ROTULO_FRASES[k].toLowerCase()}».` };
    frases[k] = v;
  }

  const cambiosRespuestas: { preguntaId: string; de: string; a: string }[] = [];
  const nuevas: CuestionarioActivo["preguntas"] = [];
  for (const [i, p] of c.preguntas.entries()) {
    const e = g.preguntas?.find((x) => x.id === p.id);
    if (!e) return { error: "Falta una de las preguntas; recarga la página e inténtalo otra vez." };
    const n = i + 1;
    const texto = limpia(e.texto, 500);
    if (texto.length < 10) return { error: `La pregunta ${n} quedó vacía o muy corta.` };
    const opciones = (e.opciones ?? []).map((o) => ({ original: o.original ? String(o.original) : null, texto: limpia(o.texto, 60), seLee: !!o.seLee })).filter((o) => o.texto);
    if (opciones.length < 2) return { error: `La pregunta ${n} necesita al menos dos respuestas posibles.` };
    if (opciones.length > 12) return { error: `La pregunta ${n} tiene demasiadas opciones (máximo 12).` };
    if (!opciones.some((o) => o.seLee)) return { error: `En la pregunta ${n} al menos una opción se tiene que decir en voz alta.` };
    const vistas = new Set<string>();
    for (const o of opciones) {
      const k = clavear(o.texto);
      if (vistas.has(k)) return { error: `En la pregunta ${n}, «${o.texto}» está repetida.` };
      vistas.add(k);
    }
    // Lo que se quitó no puede tener respuestas; lo que se renombró se lleva sus respuestas.
    const antes = leerOpciones(p.opciones);
    const quedan = new Set(opciones.map((o) => o.original).filter(Boolean));
    for (const viejo of antes.filter((x) => !quedan.has(x))) {
      const cuantas = await conRespuesta(p.id, viejo);
      if (cuantas) return { error: `«${viejo}» (pregunta ${n}) ya tiene ${cuantas} ${cuantas === 1 ? "respuesta" : "respuestas"}: no se puede quitar, pero sí cambiarle el nombre.` };
    }
    for (const o of opciones) if (o.original && o.original !== o.texto && antes.includes(o.original)) cambiosRespuestas.push({ preguntaId: p.id, de: o.original, a: o.texto });
    nuevas.push({
      ...p, texto,
      corto: limpia(e.corto, 140) || p.corto,
      reglas: renglones(e.reglas, 1200) || null,
      opciones: opciones.map((o) => o.texto),
      noSeLeen: opciones.filter((o) => !o.seLee).map((o) => o.texto),
    });
  }

  const nuevo: CuestionarioActivo = { ...c, saludo, cierre, frases: JSON.stringify(frases), version: c.version + 1, preguntas: nuevas };
  const resumen = resumir(c, nuevo);
  if (!resumen.length) return { ok: "No había nada que cambiar: el guion ya está así." };

  // Primero la asistente: si ElevenLabs no lo acepta, no se guarda nada.
  const r = await sincronizarAgente(nuevo);
  if (!r.ok) return { error: `No se guardó: ${r.error}` };

  await dbConnect();
  // Las preguntas se reescriben con su mismo _id: las respuestas de las llamadas les apuntan por ahí.
  await EncuestaCuestionarioModel.updateOne(
    { _id: c.id },
    {
      $set: {
        saludo, cierre, frases: nuevo.frases, version: nuevo.version,
        preguntas: nuevas.map((p) => ({ _id: new Types.ObjectId(p.id), clave: p.clave, texto: p.texto, corto: p.corto, tipo: p.tipo, opciones: p.opciones, noSeLeen: p.noSeLeen, reglas: p.reglas, orden: p.orden })),
      },
    },
  );
  // En dos pasos, para que intercambiar dos nombres (A→B y B→A) no los revuelva.
  for (const [k, x] of cambiosRespuestas.entries()) await renombrarRespuestas(x.preguntaId, x.de, `__renombrando__${k}`);
  for (const [k, x] of cambiosRespuestas.entries()) await renombrarRespuestas(x.preguntaId, `__renombrando__${k}`, x.a);
  await EncuestaCambioModel.create({
    cuestionarioId: c.id, version: nuevo.version, usuarioId: s.id, nombre: s.nombre, resumen: resumen.join(" · "),
    guion: JSON.stringify({ saludo, cierre, frases, preguntas: nuevas.map((p) => ({ clave: p.clave, texto: p.texto, corto: p.corto, opciones: p.opciones, noSeLeen: p.noSeLeen, reglas: p.reglas })) }),
  });
  revalidatePath("/encuestas");
  revalidatePath("/encuestas/guion");
  // Se recarga la página (y el editor, que arranca de la versión nueva) con el aviso arriba.
  redirect(`/encuestas/guion?ok=${encodeURIComponent(`Guardado (versión ${nuevo.version}). La asistente ya lo usa desde la siguiente llamada. Cambió: ${resumen.join(" · ")}.`)}`);
}

/** Qué cambió, en palabras, para el historial. */
function resumir(a: CuestionarioActivo, b: CuestionarioActivo) {
  const out: string[] = [];
  if (a.saludo !== b.saludo) out.push("introducción");
  if (a.cierre !== b.cierre) out.push("despedida");
  const fa = leerFrases(a.frases), fb = leerFrases(b.frases);
  for (const k of Object.keys(fa) as (keyof Frases)[]) if (fa[k] !== fb[k]) out.push(`respuesta «${ROTULO_FRASES[k].toLowerCase()}»`);
  for (const [i, p] of a.preguntas.entries()) {
    const q = b.preguntas[i];
    const n = `pregunta ${i + 1}`;
    if (p.texto !== q.texto) out.push(`${n}: texto`);
    if ((p.corto ?? "") !== (q.corto ?? "")) out.push(`${n}: título en el tablero`);
    if ((p.reglas ?? "") !== (q.reglas ?? "")) out.push(`${n}: indicaciones`);
    const oa = leerOpciones(p.opciones), ob = leerOpciones(q.opciones);
    if (JSON.stringify(oa) !== JSON.stringify(ob)) out.push(`${n}: opciones`);
    else if (JSON.stringify(leerOpciones(p.noSeLeen)) !== JSON.stringify(leerOpciones(q.noSeLeen))) out.push(`${n}: qué se dice en voz alta`);
  }
  return out;
}
