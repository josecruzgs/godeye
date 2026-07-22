import { Schema, models, model, type InferSchemaType } from "mongoose";

// Banco de comentarios reusable entre campañas: cada texto se marca "used"
// al asignarse a una tarea para que ninguna otra campaña vuelva a tomarlo.
const CommentSchema = new Schema(
  {
    text: { type: String, required: true },
    source: { type: String, default: "manual" }, // "manual" o la URL del Sheet importado
    used: { type: Boolean, default: false },
    usedAt: { type: Date },
    usedByTaskId: { type: Schema.Types.ObjectId, ref: "Task" },
  },
  { timestamps: true },
);

CommentSchema.index({ used: 1, createdAt: 1 });

export type Comment = InferSchemaType<typeof CommentSchema>;

export default models.Comment ?? model("Comment", CommentSchema);
