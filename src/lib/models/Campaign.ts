import mongoose, { Schema, models, model, type InferSchemaType } from "mongoose";
import { TASK_TYPES } from "./Task";

const CampaignSchema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: TASK_TYPES,
      default: "custom",
    },
    autoRun: { type: Boolean, default: false },
    taskCount: { type: Number, default: 0 },
  },
  { timestamps: true },
);

CampaignSchema.index({ createdAt: -1 });
CampaignSchema.index({ type: 1, createdAt: -1 });

export type Campaign = InferSchemaType<typeof CampaignSchema>;

// Mismo motivo que en Task: el dev server cachea el modelo compilado y un
// schema previo al tipo "likecomment" lo rechazaría al crear la campaña.
const cachedTypes = (models.Campaign?.schema.path("type") as { enumValues?: string[] } | undefined)?.enumValues;
if (models.Campaign && !cachedTypes?.includes("likecomment")) {
  mongoose.deleteModel("Campaign");
}

export default models.Campaign ?? model("Campaign", CampaignSchema);
