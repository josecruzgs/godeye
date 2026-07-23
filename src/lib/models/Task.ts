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
      ],
      required: true,
    },
    selector: { type: String },
    value: { type: String },
    url: { type: String },
    key: { type: String },
    ms: { type: Number },
    optional: { type: Boolean },
  },
  { _id: false },
);

const TaskSchema = new Schema(
  {
    name: { type: String, required: true },
    campaignId: { type: Schema.Types.ObjectId, ref: "Campaign" },
    profileId: { type: Schema.Types.ObjectId, ref: "Profile", required: true },
    type: {
      type: String,
      enum: ["login", "post", "warmup", "scrape", "like", "comment", "custom"],
      default: "custom",
    },
    steps: { type: [StepSchema], default: [] },
    status: {
      type: String,
      enum: ["pending", "queued", "running", "success", "failed", "cancelled"],
      default: "pending",
    },
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

if (models.Task && !models.Task.schema.path("campaignId")) {
  mongoose.deleteModel("Task");
}

export default models.Task ?? model("Task", TaskSchema);
