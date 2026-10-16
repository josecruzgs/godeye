import { Schema, models, model, type InferSchemaType } from "mongoose";

/**
 * Configuración del worker que se cambia desde el panel, sin tocar el VPS.
 *
 * Va aparte del latido a propósito: el latido es lo que el worker INFORMA que
 * está haciendo, y esto es lo que el admin PIDE. El worker lee este documento
 * en cada latido y ajusta sus motores; cuando lo aplicó, el latido lo refleja.
 *
 * El `_id` es el rol, igual que en WorkerHeartbeat. Hoy solo existe "tasks".
 */
const WorkerConfigSchema = new Schema(
  {
    _id: { type: String, required: true },
    /** Motores encendidos. Sin documento manda `WORKER_ENGINES` (src/lib/motores.ts). */
    engines: { type: Number },
  },
  { timestamps: true },
);

export type WorkerConfig = InferSchemaType<typeof WorkerConfigSchema>;

export default models.WorkerConfig ?? model("WorkerConfig", WorkerConfigSchema);
