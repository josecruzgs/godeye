import { Types } from "mongoose";
import { dbConnect } from "@/lib/mongodb";
import EncuestaLlamadaModel from "@/lib/models/EncuestaLlamada";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";
import EncuestaConfigModel from "@/lib/models/EncuestaConfig";
import { cuestionarioActivo, leerOpciones, esDemo } from "./llamadas";
import { ZONA } from "./fechas";

/**
 * LA ENCUESTA QUE LEVANTA LA ASISTENTE VIRTUAL.
 *
 * ElevenLabs marca, habla, escucha y al colgar deja la plática con sus campos ya extraídos. Lo que importa es que eso
 * entre a la encuesta: una llamada que ocurrió y no quedó registrada no ocurrió para ningún resultado.
 *
 * Se traen las pláticas en vez de esperar un webhook: traerlas se puede repetir cuantas veces se quiera (cada plática se
 * guarda con su identificador y el segundo intento no duplica nada) y si algo falló, se vuelve a traer y ya. Lo hacen el
 * worker cada 2 minutos (src/worker/index.ts) y el tablero abierto cada 15 segundos.
 *
 * Lo que el agente extrae se guarda tal cual, sin corregirlo: si dijo que no sabe, se guarda que no sabe.
 *
 * Es un motor ya probado en llamadas reales (timbre de 20 s para no caer en buzón, llamadas que no salieron que no gastan
 * intento, tanda que sigue sola, meta de contacto), con preguntas genéricas: cada pregunta tiene su `clave`, que es el
 * nombre del campo que extrae el agente.
 *
 * Las variables de entorno se leen al usarse y no al cargar el archivo: el worker también lo importa, y ahí dotenv corre
 * en el mismo arranque.
 */
const API = "https://api.elevenlabs.io/v1/convai";
export const agenteId = () => process.env.ELEVENLABS_AGENTE_ENCUESTA ?? "";
const numeroId = () => process.env.ELEVENLABS_NUMERO_ID ?? "";
export const hayAgenteDeVoz = () => !!(process.env.ELEVENLABS_API_KEY && agenteId());
const llaves = () => ({ "xi-api-key": process.env.ELEVENLABS_API_KEY ?? "" });

/**
 * CUÁNDO SE PUEDE LLAMAR: de 9:00 a 20:00 en hora de Baja California, todos los días. Fuera de eso no sale ninguna llamada real:
 * contesta poca gente, molesta y deja mala imagen. Las pruebas a un número propio sí salen a cualquier hora.
 * Se ajusta con LLAMADAS_HORARIO="9-20" y LLAMADAS_DIAS="1-7" (1 = lunes).
 */
const DIAS = ["", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
export function horarioDeLlamadas(ahora = new Date()) {
  const [H_INI, H_FIN] = (process.env.LLAMADAS_HORARIO ?? "9-20").split("-").map(Number);
  const [D_INI, D_FIN] = (process.env.LLAMADAS_DIAS ?? "1-7").split("-").map(Number);
  const partes = new Intl.DateTimeFormat("en-US", { timeZone: ZONA, hour: "numeric", hourCycle: "h23", weekday: "short" }).formatToParts(ahora);
  const hora = Number(partes.find((x) => x.type === "hour")?.value ?? 0);
  const dia = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(partes.find((x) => x.type === "weekday")?.value ?? "") + 1;
  const abierto = hora >= H_INI && hora < H_FIN && dia >= D_INI && dia <= D_FIN;
  const dias = D_INI === 1 && D_FIN === 7 ? "todos los días" : `de ${DIAS[D_INI]} a ${DIAS[D_FIN]}`;
  return { abierto, texto: `de ${H_INI}:00 a ${H_FIN}:00, ${dias}` };
}
const fueraDeHorario = () => `Fuera de horario: las llamadas de la encuesta salen ${horarioDeLlamadas().texto} (hora de Baja California). Las pruebas a tu número sí salen a cualquier hora.`;

type Platica = { conversation_id: string };
type Detalle = {
  conversation_id: string;
  status?: string;
  metadata?: { start_time_unix_secs?: number; call_duration_secs?: number; phone_call?: { external_number?: string; call_result?: string }; error?: { reason?: string | null; error_type?: string } | null };
  analysis?: { data_collection_results?: Record<string, { value?: unknown }>; transcript_summary?: string };
  transcript?: { role?: string; message?: string | null }[];
};

type LlamadaAbierta = { _id: Types.ObjectId; estado: string; inicio: Date; contactoId: Types.ObjectId | null; telefono: string | null; respuestas?: { preguntaId: Types.ObjectId; valor: string }[] };

/** Normaliza un texto para casar lo que dijo el agente con una opción de la lista («María José Núñez» = «maria jose nunez»). */
export const clavear = (x: string) =>
  x.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

/** TRAER LAS LLAMADAS DEL AGENTE Y REGISTRARLAS. Lo que no se pueda ligar a la base entra como prueba. */
export async function importarLlamadasDelAgente({ limite = 30 } = {}) {
  if (!hayAgenteDeVoz()) return { ok: false as const, error: "Falta la llave de ElevenLabs o el identificador del agente." };
  const c = await cuestionarioActivo();
  if (!c) return { ok: false as const, error: "No hay cuestionario cargado." };

  const lista = await fetch(`${API}/conversations?agent_id=${encodeURIComponent(agenteId())}&page_size=${limite}`, { headers: llaves(), cache: "no-store" });
  if (!lista.ok) return { ok: false as const, error: `ElevenLabs contestó ${lista.status} al pedir las pláticas.` };
  const { conversations = [] } = (await lista.json()) as { conversations?: Platica[] };

  // Las que se abrieron al marcar y siguen sin desenlace se revisan aunque ya no salgan en la primera página.
  const abiertas = await EncuestaLlamadaModel.find({ estado: "EN_CURSO", externoId: { $exists: true, $ne: null } }).select("externoId").lean<{ externoId: string }[]>();
  const ids = [...new Set([...conversations.map((x) => x.conversation_id), ...abiertas.map((x) => x.externoId)])];

  let nuevas = 0, saltadas = 0;
  const problemas: string[] = [];

  for (const id of ids) {
    const ya = await EncuestaLlamadaModel.findOne({ externoId: id }).lean<LlamadaAbierta>();
    if (ya && ya.estado !== "EN_CURSO") { saltadas++; continue; } // lo que ya tiene desenlace no se toca

    const det = await fetch(`${API}/conversations/${id}`, { headers: llaves(), cache: "no-store" });
    if (!det.ok) {
      if (ya && det.status === 404 && Date.now() - new Date(ya.inicio).getTime() > 30 * 60_000) {
        await cerrarContacto(ya.contactoId, "NO_CONTESTO", null);
        await EncuestaLlamadaModel.updateOne({ _id: ya._id }, { $set: { estado: "NO_CONTESTO", fin: new Date() } });
        nuevas++;
      } else problemas.push(`${id}: ${det.status}`);
      continue;
    }
    const d = (await det.json()) as Detalle;
    const st = (d.status ?? "").toLowerCase();
    const arranco = d.metadata?.start_time_unix_secs ? d.metadata.start_time_unix_secs * 1000 : ya ? new Date(ya.inicio).getTime() : Date.now();
    const tel = d.metadata?.phone_call?.external_number?.replace(/\D/g, "").slice(-10) || null;

    // LAS QUE NUNCA SALIERON: la plataforma las rechazó (pago, error al iniciar) o se quedaron «initiated» más de 10 min.
    // A esa persona no le sonó el teléfono: no es un intento y su contacto regresa a la fila sin gastarle un intento.
    const motivo = d.metadata?.error?.reason ?? "";
    const pago = /payment|pago|billing|quota|credit/i.test(motivo);
    // Un número que la línea no permite marcar («Account not authorized to call +52…») no es falla de la línea: es ese número,
    // y se aparta como número malo. Tomado como falla general, ese número volvía a ser el primero de la fila y frenaba todo.
    const numeroNoPermitido = esNumeroNoPermitido(motivo);
    const fallaDeSistema = !numeroNoPermitido && (pago || /initiali[sz]|internal|auth|permission|forbidden|not allowed|invalid/i.test(`${motivo} ${d.metadata?.error?.error_type ?? ""}`));
    // Con el timbre de 20 s, la que nadie contestó queda «initiated» con call_result «no_answer» (o «busy»): sí fue intento.
    const resultadoTel = (d.metadata?.phone_call?.call_result ?? "").toLowerCase();
    const sinRespuesta = ["no_answer", "no-answer", "busy", "canceled", "cancelled"].includes(resultadoTel);
    if (numeroNoPermitido && st === "failed") {
      const nota = "La línea telefónica no permite llamar a este número (permisos de Twilio).";
      if (ya) await EncuestaLlamadaModel.updateOne({ _id: ya._id }, { $set: { estado: "NO_SALIO", fin: new Date(), segundos: 0, notas: nota } });
      else await EncuestaLlamadaModel.create({ cuestionarioId: c.id, prueba: true, estado: "NO_SALIO", externoId: id, telefono: tel, inicio: new Date(arranco), fin: new Date(), segundos: 0, notas: nota });
      if (tel) await apartarNumero(tel);
      nuevas++;
      continue;
    }
    const noSalio = !sinRespuesta && ((st === "failed" && fallaDeSistema) || (st === "initiated" && Date.now() - arranco > 10 * 60_000));
    if (noSalio) {
      const nota = "No salió: la llamada no se pudo conectar.";
      const contactoId = ya?.contactoId ?? (tel ? (await EncuestaContactoModel.findOne({ telefono: tel, estado: "EN_CURSO" }).select("_id").lean<{ _id: Types.ObjectId }>())?._id ?? null : null);
      if (ya) await EncuestaLlamadaModel.updateOne({ _id: ya._id }, { $set: { estado: "NO_SALIO", fin: new Date(), segundos: 0, notas: nota } });
      else await EncuestaLlamadaModel.create({ cuestionarioId: c.id, prueba: !contactoId, estado: "NO_SALIO", externoId: id, telefono: tel, contactoId, inicio: new Date(arranco), fin: new Date(), segundos: 0, notas: nota });
      if (contactoId) await devolverContacto(contactoId);
      if (fallaDeSistema) await avisarFallaDeVoz(pago ? "PAGO" : "SERVICIO", motivo);
      nuevas++;
      continue;
    }
    if (!sinRespuesta && (st === "in-progress" || st === "initiated" || st === "processing")) { saltadas++; continue; }
    await quitarAvisoDeVoz(arranco); // una llamada que sí conectó después del aviso quiere decir que el servicio volvió

    const campos = d.analysis?.data_collection_results ?? {};
    const valor = (k: string) => { const v = campos[k]?.value; return v === null || v === undefined ? "" : String(v).trim(); };

    // El desenlace lo dice el propio agente; si no lo dijo, se deduce de cómo terminó la llamada.
    const dicho = valor("resultado").toUpperCase();
    const noLlamar = ["true", "si", "sí", "yes"].includes(valor("no_llamar").toLowerCase());
    const acepto = valor("acepto").toUpperCase();
    const hablo = (d.transcript ?? []).some((t) => t.role === "user" && (t.message ?? "").trim());
    const estados = ["COMPLETA", "RECHAZO", "COLGO", "BUZON", "NUMERO_MALO", "NO_CONTESTO"];
    // Si la persona nunca dijo nada no se habló con ella, aunque el agente lo anote como «colgó»: contestó y colgó al oír la
    // grabación. Va como «no contestó» (se le vuelve a marcar con las reglas de reintento) y no infla la meta de contacto.
    let estado = sinRespuesta ? "NO_CONTESTO" : !hablo ? (["BUZON", "NUMERO_MALO"].includes(dicho) ? dicho : "NO_CONTESTO") : estados.includes(dicho) ? dicho : acepto === "NO" ? "RECHAZO" : "COLGO";

    // Cada pregunta, con su campo. Solo se acepta una opción de la lista: si el agente devolvió otra cosa, no se inventa.
    const respuestas: { preguntaId: string; valor: string }[] = [];
    for (const p of c.preguntas) {
      const dijo = valor(p.clave);
      if (!dijo) continue;
      const opcion = leerOpciones(p.opciones).find((o) => clavear(o) === clavear(dijo));
      if (opcion) respuestas.push({ preguntaId: p.id, valor: opcion });
      else problemas.push(`«${dijo}» no es una opción de «${p.clave}»; esa respuesta quedó sin guardar.`);
    }
    if (estado === "COMPLETA" && respuestas.length < c.preguntas.length) estado = "COLGO";

    const inicio = new Date(arranco);
    const segundos = d.metadata?.call_duration_secs ?? null;
    const dicha = (d.transcript ?? [])
      .map((t) => `${t.role === "agent" ? "Asistente" : "Persona"}: ${t.message ?? ""}`)
      .filter((l) => l.length > 12)
      .join("\n");
    const datos = {
      estado, inicio, segundos,
      fin: segundos ? new Date(inicio.getTime() + segundos * 1000) : new Date(),
      notas: ((noLlamar ? "Pidió que no le vuelvan a llamar. " : "") + (d.analysis?.transcript_summary ?? "")).slice(0, 1000) || null,
      transcripcion: dicha.slice(0, 20000) || null,
    };

    // Las respuestas que ya tuviera la llamada se conservan y las nuevas las pisan por pregunta.
    const porPregunta = new Map((ya?.respuestas ?? []).map((r) => [String(r.preguntaId), r.valor]));
    for (const r of respuestas) porPregunta.set(r.preguntaId, r.valor);
    const todas = [...porPregunta].map(([preguntaId, v]) => ({ preguntaId: new Types.ObjectId(preguntaId), valor: v }));

    // La que se abrió al marcar se llena; la que no (marcada desde la consola de ElevenLabs), se reconoce por el número.
    const deLaBase = !ya && tel ? await EncuestaContactoModel.findOne({ telefono: tel, estado: "EN_CURSO" }).select("_id").lean<{ _id: Types.ObjectId }>() : null;
    let llamadaId: Types.ObjectId, contactoId: Types.ObjectId | null, telefono: string | null;
    if (ya) {
      await EncuestaLlamadaModel.updateOne({ _id: ya._id }, { $set: { ...datos, respuestas: todas } });
      llamadaId = ya._id; contactoId = ya.contactoId ?? null; telefono = ya.telefono ?? null;
    } else {
      const l = await EncuestaLlamadaModel.create({ ...datos, respuestas: todas, cuestionarioId: c.id, prueba: !deLaBase, externoId: id, telefono: tel, contactoId: deLaBase?._id ?? null, versionGuion: c.version });
      llamadaId = l._id; contactoId = deLaBase?._id ?? null; telefono = tel;
    }

    await cerrarContacto(contactoId, noLlamar ? "NO_LLAMAR" : estado, llamadaId);
    // Quien pidió que no le llamen queda apuntado aunque su número no viniera de la base (lo mandó el panel o la API):
    // así ninguna llamada futura le vuelve a marcar.
    if (noLlamar && !contactoId && telefono)
      await EncuestaContactoModel.updateOne({ telefono }, { $set: { estado: "NO_LLAMAR" }, $setOnInsert: { origen: "pidió no llamar" } }, { upsert: true }).catch(() => null);
    nuevas++;
  }
  return { ok: true as const, nuevas, saltadas, revisadas: ids.length, problemas };
}

/** El contacto de la base hereda el desenlace: así no se le vuelve a marcar a quien ya contestó. */
async function cerrarContacto(contactoId: Types.ObjectId | null, estado: string, llamadaId: Types.ObjectId | null) {
  if (!contactoId) return;
  await EncuestaContactoModel.updateOne({ _id: contactoId }, { $set: { estado, llamadaId: estado === "COMPLETA" ? llamadaId : null } }).catch(() => null);
}
/** La llamada no salió: el contacto vuelve a la fila como si no se le hubiera marcado. */
async function devolverContacto(contactoId: Types.ObjectId) {
  const c = await EncuestaContactoModel.findById(contactoId).select("intentos").lean<{ intentos: number }>();
  if (c) await EncuestaContactoModel.updateOne({ _id: contactoId }, { $set: { estado: "PENDIENTE", intentos: Math.max(0, c.intentos - 1) } }).catch(() => null);
}

async function leerConfig(clave: string) {
  return EncuestaConfigModel.findById(clave).lean<{ _id: string; valor: string }>();
}
async function guardarConfig(clave: string, valor: string) {
  await EncuestaConfigModel.updateOne({ _id: clave }, { $set: { valor } }, { upsert: true });
}
async function borrarConfig(clave: string) {
  await EncuestaConfigModel.deleteOne({ _id: clave });
}

/**
 * EL AVISO DE QUE LAS LLAMADAS NO ESTÁN SALIENDO. Se guarda en la base para que lo vea cualquiera que abra el tablero;
 * la tanda se detiene sola (para no quemar la base) y el aviso se quita en cuanto una llamada vuelve a conectar.
 */
const CLAVE_AVISO = "agente_aviso";
async function avisarFallaDeVoz(tipo: string, motivo = "") {
  const ya = await avisoDeVoz();
  const texto = tipo === "PAGO"
    ? "El servicio de voz está rechazando las llamadas por un pago pendiente. La tanda se detuvo y nadie de la base perdió su turno; en cuanto se resuelva, vuelve a apretar «Llamar ahora»."
    : /account .* not active|authentication failed|suspend/i.test(motivo)
      ? "La línea telefónica (la cuenta de Twilio del número de salida) está inactiva o suspendida, así que ninguna llamada sale. En cuanto se reactive, el sistema retoma solo."
      : "La plataforma de llamadas no está conectando las llamadas. El sistema sigue probando solo y retoma en cuanto vuelvan a salir.";
  await guardarConfig(CLAVE_AVISO, JSON.stringify({ tipo, texto, desde: ya?.desde ?? new Date().toISOString() }));
  // El pago se resuelve a mano; lo demás se prueba solo: la tanda se queda y marca de una en una hasta que una vuelva a salir.
  if (tipo === "PAGO") await detenerTanda();
}
const esNumeroNoPermitido = (motivo: string) => /not authorized to call \+?\d|is not a valid phone number|invalid ['"]?to['"]? phone/i.test(motivo);
/** Ese número no se puede marcar: sale de la fila como número malo (no cuenta en el total de la meta). */
async function apartarNumero(tel: string) {
  await EncuestaContactoModel.updateMany({ telefono: tel.slice(-10), estado: { $in: ["PENDIENTE", "NO_CONTESTO", "BUZON", "EN_CURSO"] } }, { $set: { estado: "NUMERO_MALO" } });
}
async function quitarAvisoDeVoz(siConectoEn?: number) {
  if (siConectoEn !== undefined) {
    const a = await avisoDeVoz();
    if (!a || new Date(a.desde).getTime() > siConectoEn) return; // una llamada vieja no prueba que ya se arregló
  }
  await borrarConfig(CLAVE_AVISO);
}
export async function avisoDeVoz(): Promise<{ tipo: string; texto: string; desde: string } | null> {
  await dbConnect();
  const f = await leerConfig(CLAVE_AVISO);
  try { return f ? JSON.parse(f.valor) : null; } catch { return null; }
}

/** MARCARLE A UN NÚMERO. Cuesta dinero y suena el teléfono de una persona de verdad: solo lo pide alguien desde el panel o la API. */
export async function llamarConAgente(telefono: string, { prueba = true, operadorId = null }: { prueba?: boolean; operadorId?: string | null } = {}) {
  if (!hayAgenteDeVoz()) return { ok: false as const, error: "Falta la llave de ElevenLabs o el identificador del agente." };
  if (!numeroId()) return { ok: false as const, error: "Falta decir desde qué número se llama (ELEVENLABS_NUMERO_ID)." };
  const digitos = telefono.replace(/\D/g, "");
  if (digitos.length < 10) return { ok: false as const, error: "El número va a diez dígitos." };
  const e164 = digitos.length === 10 ? `+52${digitos}` : `+${digitos}`;
  const c = await cuestionarioActivo();
  if (!c) return { ok: false as const, error: "No hay cuestionario cargado." };
  if (esDemo(c)) return { ok: false as const, error: "Está activo un cuestionario de demostración: no se llama con él." };
  if (!prueba && !horarioDeLlamadas().abierto) return { ok: false as const, error: fueraDeHorario() };
  const diez = digitos.slice(-10);
  // Quien pidió que no le llamen no recibe ninguna llamada, tampoco de prueba.
  if (await EncuestaContactoModel.exists({ telefono: diez, estado: "NO_LLAMAR" }))
    return { ok: false as const, error: "Esa persona pidió que no le volvieran a llamar." };

  const r = await fetch(`${API}/twilio/outbound-call`, {
    method: "POST",
    headers: { ...llaves(), "Content-Type": "application/json" },
    // Si nadie contesta, se cuelga a los 20 s de timbrar: antes de que entre el buzón (en México suele entrar a los 25-30 s).
    body: JSON.stringify({ agent_id: agenteId(), agent_phone_number_id: numeroId(), to_number: e164, telephony_call_config: { ringing_timeout_secs: timbreSeg() } }),
  });
  const cuerpo = (await r.json().catch(() => ({}))) as { success?: boolean; conversation_id?: string; message?: string; detail?: unknown };
  if (!r.ok || cuerpo.success === false)
    return { ok: false as const, error: `ElevenLabs contestó ${r.status}: ${cuerpo.message ?? JSON.stringify(cuerpo.detail ?? {}).slice(0, 200)}` };

  // La llamada se abre en cuanto sale: cuenta como intento aunque no contesten y al colgar se llena sola. A la base solo se
  // liga lo real: una prueba a un número de la base no le gasta su intento.
  const contacto = prueba ? null : await EncuestaContactoModel.findOne({ telefono: diez }).select("_id").lean<{ _id: Types.ObjectId }>();
  const l = await EncuestaLlamadaModel.create({
    cuestionarioId: c.id, prueba, estado: "EN_CURSO",
    // undefined y no null: el índice único de externoId es disperso, y dos null chocarían.
    externoId: cuerpo.conversation_id ?? undefined,
    telefono: diez, contactoId: contacto?._id ?? null,
    operadorId: operadorId && Types.ObjectId.isValid(operadorId) ? operadorId : null,
    versionGuion: c.version,
  });
  if (contacto) await EncuestaContactoModel.updateOne({ _id: contacto._id }, { $set: { estado: "EN_CURSO", ultimoIntento: new Date() }, $inc: { intentos: 1 } });
  return { ok: true as const, conversationId: cuerpo.conversation_id ?? null, numero: e164, llamadaId: String(l._id) };
}

/**
 * CUÁNTAS A LA VEZ. El plan de ElevenLabs y la línea atienden un número limitado de llamadas al mismo tiempo, y lo que
 * pasa de ahí se pierde: la tanda nunca abre más de `simultaneas()` y la siguiente sale cuando una cuelga. Si el número de
 * salida se comparte con otra encuesta, se reparten las líneas (ELEVENLABS_SIMULTANEAS, 5 por omisión).
 */
export const simultaneas = () => Math.max(1, parseInt(process.env.ELEVENLABS_SIMULTANEAS ?? "") || 5);
const timbreSeg = () => Math.max(10, parseInt(process.env.LLAMADAS_TIMBRE_SEG ?? "") || 20);
const lineasOcupadas = () => EncuestaLlamadaModel.countDocuments({ estado: "EN_CURSO", inicio: { $gte: new Date(Date.now() - 15 * 60_000) } });

type ContactoFila = { _id: Types.ObjectId; telefono: string };

/** MARCAR EN LOTE DESDE LA BASE: primero los que nunca se llamaron y después los reintentos, con sus reglas. */
export async function marcarEnLote({ cuantas = 10, operadorId = null }: { cuantas?: number; operadorId?: string | null } = {}) {
  if (!hayAgenteDeVoz()) return { ok: false as const, error: "Falta la llave de ElevenLabs o el identificador del agente." };
  if (!numeroId()) return { ok: false as const, error: "Falta decir desde qué número se llama (ELEVENLABS_NUMERO_ID)." };
  if (!horarioDeLlamadas().abierto) return { ok: false as const, error: fueraDeHorario() };
  const libres = Math.max(0, simultaneas() - (await lineasOcupadas()));
  const cupo = Math.min(cuantas, libres);

  const primero = await EncuestaContactoModel.find({ estado: "PENDIENTE" }).sort({ intentos: 1, createdAt: 1 }).limit(Math.max(cupo, 1)).select("telefono").lean<ContactoFila[]>();
  const reglas = await reglasDeReintento();
  const reintentos = primero.length >= cupo ? [] : await EncuestaContactoModel.find({
    estado: { $in: ["NO_CONTESTO", "BUZON"] }, intentos: { $lt: reglas.intentosMax }, ultimoIntento: { $lt: new Date(Date.now() - reglas.esperaMin * 60_000) },
  }).sort({ intentos: 1, ultimoIntento: 1 }).limit(Math.max(cupo, 1)).select("telefono").lean<ContactoFila[]>();
  const porMarcar = [...primero, ...reintentos];

  const marcadas: string[] = [];
  const saltadas: { telefono: string; porQue: string }[] = [];
  // Con aviso de falla activo se prueba con una sola: si sale, el aviso se quita y la siguiente vuelta usa todas las líneas.
  const tope = (await avisoDeVoz()) ? Math.min(1, cupo) : cupo;
  for (const c of porMarcar) {
    if (marcadas.length >= tope) break;
    const r = await llamarConAgente(c.telefono, { prueba: false, operadorId });
    if (!r.ok) {
      if (esNumeroNoPermitido(r.error)) { await apartarNumero(c.telefono); saltadas.push({ telefono: c.telefono, porQue: "la línea no permite este número" }); continue; }
      saltadas.push({ telefono: c.telefono, porQue: r.error.slice(0, 300) });
      continue;
    }
    marcadas.push(c.telefono);
  }
  // Ninguna salió y todas porque la plataforma contestó con error: es una falla que se avisa, no «no hay a quién llamar».
  if (!marcadas.length && saltadas.length && saltadas.every((x) => /^ElevenLabs contestó/.test(x.porQue))) await avisarFallaDeVoz("SERVICIO", saltadas[0].porQue);
  return { ok: true as const, marcadas: marcadas.length, saltadas, sinPorMarcar: porMarcar.length === 0, lineasLlenas: libres === 0 };
}

/**
 * LA TANDA QUE SIGUE SOLA. Se pide «llama a 200» y se guarda cuántas faltan. El worker (cada 2 min) y el tablero abierto
 * (cada 15 s) marcan las que quepan en las líneas libres. Antes de marcar se «aparta» el pedazo en la base, para que dos
 * revisiones al mismo tiempo no marquen a las mismas personas dos veces.
 */
const CLAVE_TANDA = "agente_tanda";
type Tanda = { restante: number; operadorId: string | null; desde: string };

export async function estadoTanda(): Promise<Tanda | null> {
  await dbConnect();
  const c = await leerConfig(CLAVE_TANDA);
  if (!c) return null;
  try { const t = JSON.parse(c.valor) as Tanda; return t.restante > 0 ? t : null; } catch { return null; }
}
export async function iniciarTanda(cuantas: number, operadorId: string | null) {
  await quitarAvisoDeVoz();
  await guardarConfig(CLAVE_TANDA, JSON.stringify({ restante: cuantas, operadorId, desde: new Date().toISOString() } satisfies Tanda));
  return seguirTanda();
}
export async function detenerTanda() {
  await dbConnect();
  await borrarConfig(CLAVE_TANDA);
}

export async function seguirTanda() {
  await dbConnect();
  const fila = await leerConfig(CLAVE_TANDA);
  if (!fila) return { marcadas: 0, restante: 0, sinPorMarcar: false };
  let t: Tanda;
  try { t = JSON.parse(fila.valor) as Tanda; } catch { return { marcadas: 0, restante: 0, sinPorMarcar: false }; }
  // Con meta de contacto la tanda no se acaba al terminar la base: sigue remarcando a quien no contestó (con sus reglas)
  // hasta hablar con el porcentaje pedido, o hasta que ya no quede nadie a quién volver a llamar.
  const todaMeta = await metaDeContacto();
  const meta = todaMeta && !todaMeta.terminada ? todaMeta : null;
  if (meta?.alcanzada || (meta && meta.porLlamarAlgunDia === 0)) {
    await detenerTanda();
    await guardarMeta({ ...meta.reglas, terminada: new Date().toISOString(), motivo: meta.alcanzada ? "alcanzada" : "sin más a quién llamar" });
    return { marcadas: 0, restante: 0, sinPorMarcar: true };
  }
  const sinFin = !!meta;
  if (t.restante <= 0 && !sinFin) return { marcadas: 0, restante: 0, sinPorMarcar: false };
  // Fuera de horario la tanda se pausa (no se borra): sigue sola en cuanto abra el horario.
  if (!horarioDeLlamadas().abierto) return { marcadas: 0, restante: t.restante, sinPorMarcar: false, pausada: true };

  const libres = Math.max(0, simultaneas() - (await lineasOcupadas()));
  const pedazo = sinFin ? libres : Math.min(t.restante, libres);
  if (!pedazo) return { marcadas: 0, restante: t.restante, sinPorMarcar: false };
  const apartado = await EncuestaConfigModel.updateOne({ _id: CLAVE_TANDA, valor: fila.valor }, { $set: { valor: JSON.stringify({ ...t, restante: t.restante - pedazo }) } });
  if (!apartado.modifiedCount) return { marcadas: 0, restante: t.restante, sinPorMarcar: false };

  const r = await marcarEnLote({ cuantas: pedazo, operadorId: t.operadorId });
  const marcadas = r.ok ? r.marcadas : 0;
  const ahora = await estadoTanda();
  const sinPorMarcar = r.ok && r.sinPorMarcar;
  // Sin meta: si no se pudo marcar ninguna (no quedaba a quién llamar o hubo error), la tanda se detiene en vez de dar vueltas. Con meta,
  // no marcar nada ahora no la termina: los reintentos se habilitan con el tiempo.
  const restante = sinFin ? Math.max(0, t.restante - marcadas) : sinPorMarcar || !r.ok || marcadas === 0 ? 0 : (ahora?.restante ?? 0) + (pedazo - marcadas);
  if ((sinFin && r.ok) || restante > 0) await EncuestaConfigModel.updateOne({ _id: CLAVE_TANDA }, { $set: { valor: JSON.stringify({ ...t, restante }) } });
  else await detenerTanda();
  return { marcadas, restante, sinPorMarcar, error: r.ok ? null : r.error };
}

/**
 * LA META DE CONTACTO: «remarca hasta hablar con el 35% de la base». «Hablar» es que alguien contestó, aunque haya sido
 * para decir que no. A quien no contestó se le vuelve a marcar con reglas que cuidan a la gente: máximo de intentos, espera
 * entre uno y otro y solo en horario. A quien ya contestó no se le vuelve a marcar.
 */
const CLAVE_META = "agente_meta";
type ReglasMeta = { porcentaje: number; intentosMax: number; esperaMin: number; desde: string; terminada?: string; motivo?: string };
const HABLO = ["COMPLETA", "RECHAZO", "COLGO", "NO_LLAMAR"];

async function leerMeta(): Promise<ReglasMeta | null> {
  const f = await leerConfig(CLAVE_META);
  try { return f ? (JSON.parse(f.valor) as ReglasMeta) : null; } catch { return null; }
}
async function guardarMeta(m: ReglasMeta) {
  await guardarConfig(CLAVE_META, JSON.stringify(m));
}
/** Reintentos: con meta activa, las suyas; si no, 3 intentos con 2 horas entre uno y otro. */
async function reglasDeReintento() {
  const m = await leerMeta();
  if (m && !m.terminada) return { intentosMax: m.intentosMax, esperaMin: m.esperaMin };
  return { intentosMax: 3, esperaMin: 120 };
}

export async function metaDeContacto() {
  await dbConnect();
  const m = await leerMeta();
  if (!m) return null;
  const [total, hablaron, pendientes, reintentables] = await Promise.all([
    EncuestaContactoModel.countDocuments({ estado: { $ne: "NUMERO_MALO" } }),
    EncuestaContactoModel.countDocuments({ estado: { $in: HABLO } }),
    EncuestaContactoModel.countDocuments({ estado: "PENDIENTE" }),
    EncuestaContactoModel.countDocuments({ estado: { $in: ["NO_CONTESTO", "BUZON", "EN_CURSO"] }, intentos: { $lt: m.intentosMax } }),
  ]);
  const pct = total ? Math.round((hablaron / total) * 1000) / 10 : 0;
  return { reglas: m, total, hablaron, pct, meta: m.porcentaje, alcanzada: pct >= m.porcentaje, terminada: !!m.terminada, porLlamarAlgunDia: pendientes + reintentables };
}

/** Pone la meta y deja corriendo la tanda (si no había una). */
export async function fijarMetaDeContacto(porcentaje: number, intentosMax = 5, esperaMin = 60, operadorId: string | null = null) {
  await dbConnect();
  await guardarMeta({ porcentaje, intentosMax, esperaMin, desde: new Date().toISOString() });
  if (!(await estadoTanda())) await guardarConfig(CLAVE_TANDA, JSON.stringify({ restante: 0, operadorId, desde: new Date().toISOString() } satisfies Tanda));
  return metaDeContacto();
}
export async function quitarMetaDeContacto() {
  await dbConnect();
  await borrarConfig(CLAVE_META);
}
