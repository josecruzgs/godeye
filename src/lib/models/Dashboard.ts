import { Schema, models, model, type InferSchemaType } from "mongoose";

const DashboardSchema = new Schema(
  {
    name: { type: String, required: true },
    token: { type: String, required: true, unique: true },
    campaignIds: [{ type: Schema.Types.ObjectId, ref: "Campaign" }],
  },
  { timestamps: true },
);

DashboardSchema.index({ createdAt: -1 });

export type Dashboard = InferSchemaType<typeof DashboardSchema>;

export default models.Dashboard ?? model("Dashboard", DashboardSchema);
