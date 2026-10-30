import { config } from "dotenv";
config({ path: ".env.local" });

import mongoose from "mongoose";
import { cuestionarioActivo } from "../lib/encuestas/llamadas";
import { armarAgente, sincronizarAgente } from "../lib/encuestas/guion";

/**
 * LA ASISTENTE VIRTUAL DE ENCUESTAS, ARMADA DESDE EL CUESTIONARIO DE MONGO.
 *
 * Es lo mismo que hace «Guardar» en /encuestas/guion, para usarlo desde la terminal: crear el agente la primera vez
 * (copiando voz, modelo y tiempos de ELEVENLABS_AGENTE_BASE si existe; si no, con la configuración probada en campo de
 * lib/encuestas/guion.ts) o volver a mandarle el guion.
 *
 *   npm run encuestas:agente               # enseña el guion
 *   npm run encuestas:agente -- --aplicar  # crea el agente (o actualiza ELEVENLABS_AGENTE_ENCUESTA)
 *
 * El id del agente nuevo se imprime y no se escribe solo en ningún lado: va en el .env.local de cada máquina (y en el
 * del VPS), igual que las demás variables.
 */
async function main() {
  const c = await cuestionarioActivo();
  if (!c) return console.log("No hay cuestionario.");
  const { primerMensaje, prompt, datos } = armarAgente(c);
  console.log(`Primer mensaje: ${primerMensaje}\n\n${prompt}\n\nCampos: ${Object.keys(datos).join(", ")}`);
  if (!process.argv.includes("--aplicar")) return console.log("\nPara mandarlo al agente: agrega -- --aplicar");
  const existente = process.env.ELEVENLABS_AGENTE_ENCUESTA ?? "";
  const r = await sincronizarAgente(c, { agenteId: existente, desde: process.env.ELEVENLABS_AGENTE_BASE ?? "" });
  if (!r.ok) return console.log(`\nNo se pudo: ${r.error}`);
  if (existente) return console.log(`\nActualizado el agente ${existente}.`);
  console.log(`\nCreado. Agrega esta línea al .env.local (y al del VPS) y reinicia:\nELEVENLABS_AGENTE_ENCUESTA=${r.agenteId}`);
}

main().finally(() => mongoose.disconnect());
