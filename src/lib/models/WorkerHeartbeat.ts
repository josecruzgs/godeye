import { Schema, models, model, type InferSchemaType } from "mongoose";
import { dropStaleModel } from "./staleModel";

/**
 * Latido que cada worker actualiza en cada tick, para que la UI sepa si sigue
 * vivo sin tener acceso al proceso.
 *
 * El `_id` es el ROL, no un singleton: la automatización tiene que correr en
 * una máquina con AdsPower de escritorio y la escucha no, así que en un deploy
 * real son dos procesos en dos máquinas distintas. Con un solo documento, el
 * que corriera en el VPS haría parecer viva a una automatización apagada.
 */
export type WorkerRole = "tasks" | "listening";

const WorkerHeartbeatSchema = new Schema(
  {
    _id: { type: String, required: true },
    pollIntervalMs: { type: Number, required: true },
    /** Nombre de la máquina, para saber cuál de los dos procesos es. */
    host: { type: String },
    /**
     * Cuántos motores encendió este worker (solo el rol "tasks").
     *
     * Lo informa el proceso y no una constante compartida porque el número sale
     * de `WORKER_ENGINES` en el VPS: si la sala lo tuviera hardcodeado, subir la
     * capacidad allá dejaría la pantalla mintiendo hasta el próximo deploy.
     */
    engines: { type: Number },
  },
  { timestamps: true },
);

export type WorkerHeartbeat = InferSchemaType<typeof WorkerHeartbeatSchema>;

// Mismo motivo que en Task: el modelo compilado sobrevive a las recargas del
// dev server, así que un schema sin `engines` seguiría descartando el campo.
dropStaleModel("WorkerHeartbeat", ["engines"]);

export default models.WorkerHeartbeat ?? model("WorkerHeartbeat", WorkerHeartbeatSchema);
