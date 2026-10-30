import type { CuestionarioActivo } from "./llamadas";
import { leerOpciones, esDemo } from "./llamadas";

/**
 * EL GUION DE LA ASISTENTE, ARMADO DESDE LA BASE.
 *
 * Lo que dice la asistente vive en el cuestionario (saludo, preguntas, opciones, despedida y sus frases para cada
 * situación), así que se puede cambiar desde el panel (/encuestas/guion) sin tocar código. De aquí sale el primer
 * mensaje, las instrucciones y los campos que extrae ElevenLabs; al guardar se mandan al agente y quedan vivos en la
 * siguiente llamada.
 */
/** Quién levanta la encuesta, como lo dice la asistente si se lo preguntan (ENCUESTA_EMPRESA). Vacío: no lo dice, pero tampoco inventa. */
export const EMPRESA = (process.env.ENCUESTA_EMPRESA ?? "").trim();
export type Frases = { rechazo: string; noLlamar: string; quienSoy: string; paraQuien: string };
export const FRASES_BASE: Frases = {
  rechazo: "Entiendo, le agradezco su tiempo. ¡Que tenga excelente día!",
  noLlamar: "Con gusto, lo anoto. ¡Que tenga excelente día!",
  quienSoy: `Soy una asistente virtual${EMPRESA ? ` de ${EMPRESA}` : ""}; estoy levantando una encuesta de opinión de dos preguntas. No le voy a pedir ningún dato personal.`,
  paraQuien: EMPRESA ? `La realiza ${EMPRESA}. No tengo más información sobre el estudio.` : "Es un estudio de opinión; no estoy autorizada a dar el nombre de quien lo encarga.",
};
export const ROTULO_FRASES: Record<keyof Frases, string> = {
  rechazo: "Si no quiere participar",
  noLlamar: "Si pide que no le vuelvan a llamar",
  quienSoy: "Si pregunta quién habla o si es una persona",
  paraQuien: "Si pregunta para quién es la encuesta",
};

export function leerFrases(crudo: string | null | undefined): Frases {
  try { return { ...FRASES_BASE, ...(crudo ? (JSON.parse(crudo) as Partial<Frases>) : {}) }; } catch { return FRASES_BASE; }
}

const comillas = (x: string) => x.replace(/[«»]/g, '"').trim();
const frase = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(", ")} o ${xs[xs.length - 1]}` : xs.join(""));

/**
 * LOS TIEMPOS DE TURNO. Con solo 2.5 s de silencio («eager») antes de volver a hablar, a quien se quedaba pensando le
 * repetía la pregunta completa, hasta tres veces seguidas, y buena parte de esas personas colgaba. Con 6 s y «normal» la deja pensar sin que la llamada se sienta muerta.
 */
export const TURNO = { turn_timeout: 6, turn_eagerness: "normal", silence_end_call_timeout: 15 } as const;

/**
 * EL ECO DE SU PROPIA VOZ. En el teléfono, lo que dice la asistente a veces regresa por la línea y se transcribe como si lo
 * hubiera dicho la persona: justo cuando leía un nombre de la lista, el sistema «oyó» a la persona decir ese apellido
 * (en la grabación no se oye) y la asistente cortó la lista; en una llamada hasta se despidió antes de la respuesta. Las
 * palabras de las opciones no interrumpen: la asistente termina de leer y entonces escucha.
 */
export function palabrasSinInterrupcion(c: CuestionarioActivo) {
  const t = new Set<string>();
  for (const p of c.preguntas)
    for (const o of leerOpciones(p.opciones)) {
      t.add(o);
      for (const w of o.split(/\s+/)) if (w.length >= 3) t.add(w);
    }
  return [...t].slice(0, 80);
}

export function armarAgente(c: CuestionarioActivo) {
  const frases = leerFrases(c.frases);
  const n = c.preguntas.length;
  const preguntas = c.preguntas.map((p, i) => {
    const opciones = leerOpciones(p.opciones);
    const callar = leerOpciones(p.noSeLeen);
    const reglas = (p.reglas ?? "").split("\n").map((l) => l.replace(/^\s*[-•]\s*/, "").trim()).filter(Boolean);
    return `# PREGUNTA ${i + 1}
${i === 0 ? "" : "NO vuelvas a saludar. Di «Gracias.» y enseguida, "}Dices exactamente, de corrido y sin números: «${comillas(p.texto)}»
- Las únicas respuestas que registras son: ${opciones.map((o) => `«${o}»`).join(", ")}. Acepta una sola; si menciona dos, le pides que escoja una.
${callar.length ? `- NO digas ${callar.map((o) => `«${o}»`).join(" ni ")} como opción. Pero si la persona lo contesta, lo registras igual.\n` : ""}${reglas.map((r) => `- ${r}\n`).join("")}- Si pregunta «¿cuál?», «¿cómo?» o pide que repitas: repites SOLO las opciones, una vez («${frase(opciones.filter((o) => !callar.includes(o)))}»). No repitas la pregunta completa.
- Si se queda callada, está pensando: espérala. No repitas nada.
- Si mientras todavía lees las opciones «se oye» un nombre o una palabra que tú misma acabas de decir, es el eco de tu voz en la línea, no su respuesta: termina de leer y espera. Solo cuenta lo que la persona dice después de que terminaste de preguntar. Nunca te despidas sin tener su respuesta.
- No preguntes por qué y no comentes la respuesta.${i === n - 1 ? " Después de esta pregunta la encuesta se acabó: nunca regreses a las anteriores." : ""}`;
  });

  const prompt = `# Quién eres
Eres una asistente virtual${EMPRESA ? ` de ${EMPRESA}` : ""}. Levantas por teléfono una encuesta de opinión muy corta sobre ${c.municipio ? `el futuro de ${c.municipio}` : "temas de tu estado"}. Hablas español de México, con calidez, claridad y sin prisa. Tu único trabajo es levantar esta encuesta y colgar.

# La regla que manda sobre todas
Eres neutral. No opines, no comentes, no felicites, no corrijas y no des información sobre ninguna institución, persona u opción por la que preguntas. Si te preguntan quién es alguien: «Solo estoy levantando la encuesta, no tengo información de las personas». Si insisten, repites la pregunta. Cualquier comentario tuyo contamina la respuesta.

# Cómo abres
Tu primer mensaje ya está dicho (la introducción). Esperas la respuesta.
- Si dice que sí (o «adelante», «está bien», «a ver»): pasas a la PREGUNTA 1.
- Si dice que no, que está ocupado o que no le interesa: «${comillas(frases.rechazo)}», y terminas con end_call.
- Si pide que no le vuelvan a llamar: «${comillas(frases.noLlamar)}», y terminas con end_call.
- Si pregunta quién eres o si eres una persona: «${comillas(frases.quienSoy)}». Y vuelves a pedir permiso.
- Si pregunta para quién es la encuesta: «${comillas(frases.paraQuien)}». No digas nada más sobre quién la encarga: no inventes clientes ni instituciones.
- Si notas que habla un menor de edad: agradeces y terminas con end_call.

${preguntas.join("\n\n")}

# Cómo cierras
Dices: «${comillas(c.cierre ?? "¡Muchas gracias por participar! ¡Que tenga excelente día!")}» Y terminas con end_call.

# Si cuelga a media o cae en buzón
Lo que se alcanzó a preguntar vale. En buzón o grabadora no dejas mensaje: terminas con end_call.

# Cosas que nunca haces
- No pides nombre, dirección, edad, correo ni ningún dato personal.
- No prometes nada, no ofreces nada y no pides el voto por nadie.
- No te alargas: ${n === 1 ? "es una pregunta" : `son ${n} preguntas`} y se acaba.
- Nunca dices la misma frase dos veces seguidas. Si la persona tarda en contestar, esperas; si después de un buen rato no se oye nada, dices solo «¿Me escucha?».`;

  const datos: Record<string, { type: "string" | "boolean"; description: string }> = {
    acepto: { type: "string", description: "¿Aceptó participar en la encuesta? Responde SI o NO." },
    resultado: { type: "string", description: `Cómo terminó la llamada. Responde exactamente con uno de: COMPLETA (contestó ${n === 1 ? "la pregunta" : `las ${n} preguntas`}), RECHAZO (no quiso participar o pidió que no le llamen), COLGO (empezó y colgó a media), BUZON (cayó en buzón o grabadora), NUMERO_MALO (número equivocado).` },
    no_llamar: { type: "boolean", description: "true solo si la persona pidió expresamente que no le vuelvan a llamar; false en cualquier otro caso." },
  };
  for (const p of c.preguntas)
    datos[p.clave] = { type: "string", description: `${comillas(p.texto)} Responde exactamente con uno de: ${leerOpciones(p.opciones).join(", ")}. Si nunca se llegó a esta pregunta, deja el valor vacío.` };

  return { primerMensaje: c.saludo, prompt, datos };
}

const API = "https://api.elevenlabs.io/v1/convai/agents";
type Cfg = { conversation_config: Record<string, unknown> & { turn: unknown; agent: Record<string, unknown> & { prompt: Record<string, unknown> } } };

/**
 * LA CONFIGURACIÓN PROBADA EN CAMPO, para crear el agente desde cero (sin ELEVENLABS_AGENTE_BASE de donde copiarla).
 * Voz femenina mexicana de la Voice Library (ELEVENLABS_VOZ para otra), el modelo de voz más rápido, transcripción de alta
 * calidad y llamadas de máximo 5 minutos. El guion, los tiempos de turno y las herramientas se ponen encima en sincronizarAgente.
 */
const CONFIG_BASE: Cfg = {
  conversation_config: {
    agent: { language: "es", prompt: { llm: "gemini-2.5-flash", temperature: 0.3 } },
    tts: { model_id: "eleven_flash_v2_5", voice_id: process.env.ELEVENLABS_VOZ || "ewn5JTa3lNPY8QVuZJi6", stability: 0.45, similarity_boost: 0.8, speed: 1.04, optimize_streaming_latency: 4, agent_output_audio_format: "pcm_16000" },
    asr: { quality: "high", provider: "scribe_realtime", user_input_audio_format: "pcm_16000" },
    turn: { mode: "turn" },
    conversation: { max_duration_seconds: 300 },
  },
};

/**
 * MANDAR EL GUION AL AGENTE. Se parte de la configuración que ya tiene (voz, modelo, tiempos de turno) y solo se cambia lo
 * del guion, junto con lo que le permite colgar sola: end_call, la detección de buzón y el corte tras 15 s de silencio.
 * `desde` es el agente del que se copia la configuración cuando se crea uno nuevo.
 */
export async function sincronizarAgente(c: CuestionarioActivo, { agenteId = process.env.ELEVENLABS_AGENTE_ENCUESTA ?? "", desde = "", nombre = "Ojo de Dios · Encuesta telefónica" } = {}) {
  const llave = process.env.ELEVENLABS_API_KEY;
  if (!llave) return { ok: false as const, error: "Falta la llave de ElevenLabs." };
  if (esDemo(c)) return { ok: false as const, error: "Es un cuestionario de demostración: no se manda al agente." };
  const origen = agenteId || desde;
  const H = { "xi-api-key": llave, "Content-Type": "application/json" };
  let b: Cfg = CONFIG_BASE;
  if (origen) {
    const actual = await fetch(`${API}/${origen}`, { headers: H, cache: "no-store" });
    if (!actual.ok) return { ok: false as const, error: `ElevenLabs contestó ${actual.status} al leer el agente.` };
    b = (await actual.json()) as Cfg;
  }
  const { primerMensaje, prompt, datos } = armarAgente(c);
  const pb = b.conversation_config.agent.prompt;
  const herramientas = {
    end_call: { type: "system", name: "end_call", description: "Termina la llamada cuando la encuesta acabó, cuando la persona no quiere participar o pide que no le llamen, o cuando contesta un buzón o una grabadora.", params: { system_tool_type: "end_call" } },
    voicemail_detection: { type: "system", name: "voicemail_detection", description: "Detecta si contestó un buzón de voz o una grabadora y cuelga sin dejar mensaje.", params: { system_tool_type: "voicemail_detection", voicemail_message: "" } },
  };
  const cuerpo = {
    name: nombre,
    conversation_config: {
      ...b.conversation_config,
      turn: { ...(b.conversation_config.turn as Record<string, unknown>), ...TURNO, interruption_ignore_terms: palabrasSinInterrupcion(c), merge_with_default_ignore_terms: true },
      agent: { ...b.conversation_config.agent, first_message: primerMensaje, language: "es", prompt: { ...pb, prompt, built_in_tools: { ...(pb.built_in_tools as object), ...herramientas } } },
    },
    platform_settings: { data_collection: datos },
  };
  const r = agenteId
    ? await fetch(`${API}/${agenteId}`, { method: "PATCH", headers: H, body: JSON.stringify(cuerpo) })
    : await fetch(`${API}/create`, { method: "POST", headers: H, body: JSON.stringify(cuerpo) });
  const j = (await r.json().catch(() => ({}))) as { agent_id?: string; detail?: unknown };
  if (!r.ok) return { ok: false as const, error: `ElevenLabs no aceptó el guion (${r.status}): ${JSON.stringify(j.detail ?? j).slice(0, 200)}` };
  return { ok: true as const, agenteId: agenteId || j.agent_id || "" };
}
