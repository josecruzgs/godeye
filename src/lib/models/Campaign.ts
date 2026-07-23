import { Schema, models, model, type InferSchemaType } from "mongoose";

const CampaignSchema = new Schema(
  {
    name: { type: String, required: true },
    type: {
      type: String,
      enum: ["login", "post", "warmup", "scrape", "like", "comment", "custom"],
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

export default models.Campaign ?? model("Campaign", CampaignSchema);
