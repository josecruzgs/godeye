"use server";

import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { dbConnect } from "@/lib/mongodb";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";
import EncuestaLlamadaModel from "@/lib/models/EncuestaLlamada";
import { requireAdmin, requireSesion } from "@/lib/encuestas/acceso";
import {
  importarLlamadasDelAgente, llamarConAgente, iniciarTanda, seguirTanda, detenerTanda,
  fijarMetaDeContacto, quitarMetaDeContacto, metaDeContacto, horarioDeLlamadas, simultaneas,
} from "@/lib/encuestas/agente_voz";
import { cargarFilas, textoAFilas, filtroVisible } from "@/lib/encuestas/base";
import { leerXlsx } from "@/lib/encuestas/xlsx";

function volver(msg: string, ok = true, ancla = "", base = "/encuestas"): never {
  redirect(`${base}?${ok ? "ok" : "error"}=${encodeURIComponent(msg)}${ancla}`);
}
const n = (x: number) => x.toLocaleString("es-MX");

/** «Llamar ahora»: arranca la tanda. Salen las que quepan en las líneas y el resto sigue sola (cron + tablero abierto). */
export async function llamarAhora(formData: FormData) {
  const s = await requireAdmin();
  if (!horarioDeLlamadas().abierto) volver(`Fuera de horario: se llama ${horarioDeLlamadas().texto}.`, false);
  await dbConnect();
  const pendientes = await EncuestaContactoModel.countDocuments({ estado: { $in: ["PENDIENTE", "NO_CONTESTO", "BUZON"] } });
  if (!pendientes) volver("No hay a quién llamar: sube primero la base de teléfonos.", false, "#base");
  const cuantas = Math.min(5000, Math.max(1, Number(String(formData.get("cuantas") ?? "").replace(/\D/g, "")) || 20));
  const meta = Math.min(100, Number(String(formData.get("meta") ?? "").replace(/[^\d.]/g, "")) || 0);
  const { espera, intentos } = reglasDelFormulario(formData);
  // A quien no contesta se le vuelve a marcar con las reglas que se pusieron (cada N minutos, hasta N veces). Sin porcentaje,
  // la meta es «todos»: sigue hasta que ya no quede a quién volver a marcar. Con 1 intento no se remarca a nadie.
  if (intentos > 1 || meta > 0) await fijarMetaDeContacto(meta || 100, intentos, espera, s.id);
  else await quitarMetaDeContacto();
  const r = await iniciarTanda(cuantas, s.id);
  revalidatePath("/encuestas");
  if (r.error) volver(r.error, false);
  volver(`Arrancó: ${r.marcadas} ${r.marcadas === 1 ? "llamada salió" : "llamadas salieron"} ya y el resto sale sola, de ${simultaneas()} en ${simultaneas()}.${intentos > 1 ? ` A quien no conteste se le vuelve a marcar cada ${espera} minutos, hasta ${intentos} veces.` : ""}${meta && meta < 100 ? ` Se detiene al hablar con el ${meta}% de la base.` : ""}`);
}

function reglasDelFormulario(formData: FormData) {
  const espera = Math.min(24 * 60, Math.max(5, Number(String(formData.get("espera") ?? "").replace(/\D/g, "")) || 5));
  const intentos = Math.min(10, Math.max(1, Number(String(formData.get("intentos") ?? "").replace(/\D/g, "")) || 3));
  return { espera, intentos };
}

/** Cambiar cada cuánto y cuántas veces se vuelve a marcar, con las llamadas ya corriendo. */
export async function ajustarRemarcado(formData: FormData) {
  const s = await requireAdmin();
  const { espera, intentos } = reglasDelFormulario(formData);
  const actual = await metaDeContacto();
  await fijarMetaDeContacto(actual && !actual.terminada ? actual.meta : 100, intentos, espera, s.id);
  revalidatePath("/encuestas");
  volver(`Listo: a quien no conteste se le vuelve a marcar cada ${espera} minutos, hasta ${intentos} veces (solo en horario).`);
}

export async function detenerLlamadas() {
  await requireAdmin();
  await detenerTanda();
  await quitarMetaDeContacto();
  revalidatePath("/encuestas");
  volver("Detenido. Las que ya estaban en la línea terminan normal y se registran solas.");
}

/**
 * «Mandar la encuesta a un número»: la asistente llama a ese número y le hace la encuesta. Cuenta en los resultados (respeta el
 * horario y a quien pidió que no le llamen); con «Es prueba» sale a cualquier hora y no cuenta. Lo mismo que POST /api/v1/llamar.
 */
export async function mandarEncuesta(formData: FormData) {
  const s = await requireAdmin();
  const tel = String(formData.get("telefono") ?? "");
  const prueba = formData.get("prueba") === "on";
  const r = await llamarConAgente(tel, { prueba, operadorId: s.id });
  revalidatePath("/encuestas");
  if (!r.ok) volver(r.error, false, "#mandar");
  volver(`Llamando a ${r.numero}. La respuesta aparece en «Las encuestas hechas» en cuanto cuelgue${prueba ? " (es prueba: no cuenta en los resultados)" : ""}.`, true, "#mandar");
}

/** Probar el guion con tu propio número: sale a cualquier hora y nunca cuenta en los resultados. */
export async function probarConMiNumero(formData: FormData) {
  const s = await requireAdmin();
  const tel = String(formData.get("telefono") ?? "");
  const base = formData.get("desde") === "guion" ? "/encuestas/guion" : "/encuestas"; // el editor del guion también tiene «Llamarme»
  const r = await llamarConAgente(tel, { prueba: true, operadorId: s.id });
  revalidatePath("/encuestas");
  if (!r.ok) volver(r.error, false, "#probar", base);
  volver(`Llamando a ${r.numero}: contesta como si fueras una persona de la base. Es prueba: no cuenta en los resultados.`, true, "#probar", base);
}

/** Lo que pregunta el tablero abierto cada 15 s: registra lo que ya colgó y marca los siguientes. Lo mismo hace el worker cada 2 min. */
export async function seguirLlamadas() {
  await requireSesion();
  const a = await importarLlamadasDelAgente({ limite: 30 });
  const t = await seguirTanda();
  const cambiaron = (a.ok && a.nuevas > 0) || t.marcadas > 0;
  if (cambiaron) revalidatePath("/encuestas");
  return { cambiaron };
}

export async function traerLlamadas() {
  await requireAdmin();
  const a = await importarLlamadasDelAgente({ limite: 100 });
  revalidatePath("/encuestas");
  if (!a.ok) volver(a.error, false);
  volver(a.nuevas ? `${a.nuevas} ${a.nuevas === 1 ? "llamada registrada" : "llamadas registradas"}.` : "No había nada nuevo: todo lo que habló la asistente ya está registrado.");
}

/** SUBIR LA BASE: Excel, CSV o la columna de teléfonos pegada. */
export async function subirBase(formData: FormData) {
  const s = await requireAdmin();
  const archivo = formData.get("archivo");
  const pegado = String(formData.get("pegado") ?? "");
  let filas: string[][] = [];
  let origen = "pegado";
  try {
    if (archivo instanceof File && archivo.size) {
      if (archivo.size > 8_000_000) volver("El archivo pasa de 8 MB. Pártelo en dos y sube cada parte.", false, "#base");
      origen = archivo.name.slice(0, 120);
      filas = /\.xlsx$/i.test(archivo.name) ? leerXlsx(Buffer.from(await archivo.arrayBuffer())) : textoAFilas(await archivo.text());
      if (/\.xls$/i.test(archivo.name)) volver("Ese es un Excel viejo (.xls). Ábrelo y guárdalo como .xlsx o CSV, y vuélvelo a subir.", false, "#base");
    } else if (pegado.trim()) filas = textoAFilas(pegado);
    else volver("No llegó ningún archivo ni números pegados.", false, "#base");
  } catch (e) {
    unstable_rethrow(e); // el redirect de volver() no es un error
    volver(e instanceof Error ? e.message : "No pude leer el archivo.", false, "#base");
  }
  // Quien la sube es su dueño: solo él ve los nombres y los números (ver lib/encuestas/cifrado.ts).
  const r = await cargarFilas(filas, origen, s.id);
  revalidatePath("/encuestas");
  if (!r.cargadas && !r.repetidas) volver(`No encontré teléfonos válidos (${n(r.leidas)} renglones leídos). Revisa que la columna traiga celulares de 10 dígitos.`, false, "#base");
  const partes = [`${n(r.cargadas)} ${r.cargadas === 1 ? "teléfono nuevo cargado" : "teléfonos nuevos cargados"} de ${n(r.leidas)} renglones.`];
  if (r.repetidas) partes.push(`${n(r.repetidas)} ${r.repetidas === 1 ? "ya estaba" : "ya estaban"} y no se duplicaron.`);
  partes.push("Se guardaron cifrados: solo tú ves los nombres y los números.");
  if (r.sinTelefono) partes.push(`${n(r.sinTelefono)} sin celular válido quedaron fuera.`);
  volver(partes.join(" "), true, "", "/encuestas/base"); // directo a la lista, para ver lo que se cargó con nombre y número
}

/**
 * Vaciar la lista. Las llamadas hechas y sus respuestas se quedan: lo que se va es la lista de teléfonos.
 * Cada quien vacía lo suyo (y lo compartido): la base que subió otro usuario no se le puede borrar desde aquí.
 */
export async function vaciarBase() {
  const s = await requireAdmin();
  await dbConnect();
  if (await EncuestaLlamadaModel.exists({ estado: "EN_CURSO" })) volver("Hay llamadas en la línea: deténlas y espera a que cuelguen antes de vaciar la base.", false, "#base");
  await detenerTanda();
  // Quien pidió que no le llamen se queda apuntado: vaciar la lista no puede volver a ponerlo a tiro.
  const r = await EncuestaContactoModel.deleteMany({ estado: { $ne: "NO_LLAMAR" }, ...filtroVisible(s.id) });
  revalidatePath("/encuestas");
  volver(`Base vaciada: ${n(r.deletedCount)} teléfonos. Las encuestas hechas siguen guardadas, y quien pidió que no le llamen sigue apuntado.`, true, "#base");
}
