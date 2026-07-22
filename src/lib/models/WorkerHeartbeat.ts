import { Schema, models, model, type InferSchemaType } from "mongoose";

// Documento singleton (_id fijo) que el worker actualiza en cada tick para
// que la UI pueda mostrar si sigue vivo sin depender de acceso al proceso.
const WorkerHeartbeatSchema = new Schema(
  {
    _id: { type: String, default: "singleton" },
    pollIntervalMs: { type: Number, required: true },
  },
  { timestamps: true },
);

export type WorkerHeartbeat = InferSchemaType<typeof WorkerHeartbeatSchema>;

export default models.WorkerHeartbeat ?? model("WorkerHeartbeat", WorkerHeartbeatSchema);
