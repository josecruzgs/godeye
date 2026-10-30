import { dbConnect } from "@/lib/mongodb";
import EncuestaContactoModel from "@/lib/models/EncuestaContacto";

/**
 * LA BASE A LA QUE SE LE VA A LLAMAR.
 *
 * Entra como venga: Excel, CSV (con coma, punto y coma o tabulador) o la columna de teléfonos copiada y pegada. Lo que no
 * trae un celular válido no entra, y lo repetido no se duplica (se cuenta y se dice): un número que aparece dos veces se
 * llama dos veces, y eso es lo que hace que la gente cuelgue.
 */
export function celularValido(entrada: string | null | undefined): string | null {
  const t = (entrada ?? "").replace(/\D/g, "").replace(/^521(?=\d{10}$)/, "").replace(/^52(?=\d{10}$)/, "");
  if (t.length !== 10 || /^[01]/.test(t)) return null;
  if (new Set(t).size < 3) return null; // 5555555555, 6666660000…
  const sube = "0123456789012345678901234567890";
  if (sube.includes(t) || [...sube].reverse().join("").includes(t)) return null;
  return t;
}

const SINONIMOS: Record<string, string[]> = {
  telefono: ["telefono", "tel", "celular", "cel", "movil", "numero", "phone", "whatsapp", "telefonocelular", "numerodetelefono"],
  nombre: ["nombre", "nombres", "name", "nombrecompleto", "nombredelapersona", "ciudadano", "contacto"],
  paterno: ["apellidopaterno", "paterno", "apellido1", "primerapellido", "apellido"],
  materno: ["apellidomaterno", "materno", "apellido2", "segundoapellido"],
  apellidos: ["apellidos"],
  colonia: ["colonia", "col", "fraccionamiento", "barrio"],
};
const limpio = (x: string) => x.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]/g, "");

/** Parte una línea de CSV respetando las comillas. */
function partir(linea: string, sep: string): string[] {
  const out: string[] = [];
  let actual = "", dentro = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (c === '"') { if (dentro && linea[i + 1] === '"') { actual += '"'; i++; } else dentro = !dentro; }
    else if (c === sep && !dentro) { out.push(actual); actual = ""; }
    else actual += c;
  }
  out.push(actual);
  return out.map((x) => x.trim());
}

export function textoAFilas(texto: string): string[][] {
  const lineas = texto.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (!lineas.length) return [];
  const sep = [",", ";", "\t", "|"].map((s) => ({ s, n: lineas[0].split(s).length })).sort((a, b) => b.n - a.n)[0].s;
  return lineas.map((l) => partir(l, sep));
}

export type ResumenCarga = { leidas: number; cargadas: number; repetidas: number; sinTelefono: number; columna: string | null };

export async function cargarFilas(filas: string[][], origen: string): Promise<ResumenCarga> {
  if (!filas.length) return { leidas: 0, cargadas: 0, repetidas: 0, sinTelefono: 0, columna: null };
  // ¿El primer renglón es encabezado? Si trae una columna que se llama «teléfono» (o parecido), sí.
  const enc = filas[0].map(limpio);
  const idx = (campo: string) => enc.findIndex((h) => SINONIMOS[campo].includes(h));
  let iTel = idx("telefono");
  const conEncabezado = iTel >= 0;
  const cuerpo = conEncabezado ? filas.slice(1) : filas;
  // Sin encabezado: la columna de teléfonos es la que más celulares válidos trae.
  if (!conEncabezado) {
    const ancho = Math.max(...cuerpo.map((f) => f.length));
    let mejor = -1, cuenta = 0;
    for (let k = 0; k < ancho; k++) {
      const n = cuerpo.slice(0, 200).filter((f) => celularValido(f[k])).length;
      if (n > cuenta) { cuenta = n; mejor = k; }
    }
    iTel = mejor;
  }
  if (iTel < 0) return { leidas: cuerpo.length, cargadas: 0, repetidas: 0, sinTelefono: cuerpo.length, columna: null };
  const iNom = conEncabezado ? idx("nombre") : -1, iCol = conEncabezado ? idx("colonia") : -1;
  // Hay bases con el nombre y los apellidos en columnas aparte: se juntan en el orden en que se dicen.
  const iPat = conEncabezado ? idx("paterno") : -1, iMat = conEncabezado ? idx("materno") : -1, iAps = conEncabezado ? idx("apellidos") : -1;
  const nombreDe = (f: string[]) => [iNom, iAps, iPat, iMat].filter((k) => k >= 0).map((k) => (f[k] ?? "").trim()).filter(Boolean).join(" ").replace(/\s+/g, " ").slice(0, 160) || null;

  const vistos = new Set<string>();
  const nuevos: { telefono: string; nombre: string | null; colonia: string | null; origen: string }[] = [];
  let repetidas = 0, sinTelefono = 0;
  for (const f of cuerpo) {
    const tel = celularValido(f[iTel]);
    if (!tel) { sinTelefono++; continue; }
    if (vistos.has(tel)) { repetidas++; continue; }
    vistos.add(tel);
    nuevos.push({ telefono: tel, nombre: nombreDe(f), colonia: iCol >= 0 ? f[iCol] || null : null, origen });
  }
  // Lo que ya estaba de una carga anterior no se toca: lo que ya se llamó, ya se llamó. Por eso es $setOnInsert y
  // no un insert a secas: el número que ya existe se queda como estaba y solo cuenta como repetido.
  await dbConnect();
  let cargadas = 0;
  for (let k = 0; k < nuevos.length; k += 500) {
    const r = await EncuestaContactoModel.bulkWrite(
      nuevos.slice(k, k + 500).map((c) => ({
        updateOne: { filter: { telefono: c.telefono }, update: { $setOnInsert: c }, upsert: true },
      })),
      { ordered: false },
    );
    cargadas += r.upsertedCount;
  }
  repetidas += nuevos.length - cargadas;
  return { leidas: cuerpo.length, cargadas, repetidas, sinTelefono, columna: conEncabezado ? filas[0][iTel] : null };
}

/** Cómo va la base. */
export async function estadoBase() {
  await dbConnect();
  const g = await EncuestaContactoModel.aggregate<{ _id: string; n: number }>([{ $group: { _id: "$estado", n: { $sum: 1 } } }]);
  const porEstado = Object.fromEntries(g.map((x) => [x._id, x.n])) as Record<string, number>;
  const total = g.reduce((a, x) => a + x.n, 0);
  return { total, porEstado };
}
