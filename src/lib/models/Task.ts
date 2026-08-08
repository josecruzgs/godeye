import mongoose, { Schema, models, model, type InferSchemaType } from "mongoose";

// Un "step" es una acción atómica de Playwright que el runner interpreta.
// Ver src/lib/automation/runner.ts para la lista de acciones soportadas.
const StepSchema = new Schema(
  {
    action: {
      type: String,
      enum: [
        "goto",
        "click",
        "hover",
        "fill",
        "type",
        "press",
        "waitForSelector",
        "waitForTimeout",
        "screenshot",
        "scroll",
        "uploadFile",
        "likeComment",
      ],
      required: true,
    },
    selector: { type: String },
    value: { type: String },
    url: { type: String },
    key: { type: String },
    ms: { type: Number },
    optional: { type: Boolean },
    // Solo para "likeComment": el id del comentario a reaccionar (sale del
    // `comment_id`/`reply_comment_id` del link) y, cuando la reacción no es
    // "me gusta", el selector de la reacción dentro del picker de Facebook.
    commentId: { type: String },
    reactionSelector: { type: String },
  },
  { _id: false },
);

export const TASK_TYPES = [
  "login",
  "post",
  "warmup",
  "scrape",
  "like",
  "likecomment",
  "comment",
  "custom",
] as const;

const TaskSchema = new Schema(
  {
    name: { type: String, required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign" },
    profileId: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
    type: {
      type: String,
      enum: TASK_TYPES,
      default: "custom",
    },
    steps: { type: [StepSchema], default: [] },
    status: {
      type: String,
      enum: ["pending", "queued", "running", "success", "failed", "cancelled", "paused"],
      default: "pending",
    },
    // Solo se usa mientras status === "paused": guarda a qué estado volver
    // al reanudar (una tarea "pending" no debe reanudar directo a "queued").
    resumeStatus: { type: String, enum: ["pending", "queued"] },
    scheduledAt: { type: Date, default: () => new Date() },
    startedAt: { type: Date },
    finishedAt: { type: Date },
    error: { type: String },
  },
  { timestamps: true },
);

TaskSchema.index({ status: 1, scheduledAt: 1 });
TaskSchema.index({ campaignId: 1, status: 1 });

export type Task = InferSchemaType<typeof TaskSchema>;

// El modelo compilado se cachea entre recargas del dev server, así que un
// schema viejo sobrevive a los cambios de este archivo y rechaza los valores
// nuevos. Se descarta cuando le falta algo que esta versión sí tiene.
function isStaleTaskModel() {
  const schema = models.Task?.schema;
  if (!schema) return false;
  if (!schema.path("campaignId")) return true;
  const types = (schema.path("type") as { enumValues?: string[] }).enumValues ?? [];
  return !types.includes("likecomment");
}

if (isStaleTaskModel()) {
  mongoose.deleteModel("Task");
}

export default models.Task ?? model("Task", TaskSchema);
