import { Schema, models, model } from "mongoose";

/**
 * La base de teléfonos a la que llama la asistente.
 *
 * Estados: PENDIENTE, EN_CURSO, COMPLETA, RECHAZO, COLGO, NO_CONTESTO, BUZON,
 * NUMERO_MALO, NO_LLAMAR. Quien pidió que no le llamen queda como NO_LLAMAR
 * para siempre, aunque su número no viniera de la base.
 */
const EncuestaContactoSchema = new Schema(
  {
    telefono: { type: String, required: true },
    nombre: { type: String, default: null },
    colonia: { type: String, default: null },
    /** De qué archivo salió. */
    origen: { type: String, default: null },
    estado: { type: String, default: "PENDIENTE" },
    intentos: { type: Number, default: 0 },
    ultimoIntento: { type: Date, default: null },
    /** La llamada en la que sí contestó todo. */
    llamadaId: { type: Schema.Types.ObjectId, ref: "EncuestaLlamada", default: null },
  },
  { timestamps: true, collection: "encuestas_contactos" },
);

EncuestaContactoSchema.index({ telefono: 1 }, { unique: true });
EncuestaContactoSchema.index({ estado: 1, intentos: 1, ultimoIntento: 1 });
EncuestaContactoSchema.index({ createdAt: -1 });

export default models.EncuestaContacto ?? model("EncuestaContacto", EncuestaContactoSchema);
