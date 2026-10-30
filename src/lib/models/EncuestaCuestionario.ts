import { Schema, models, model } from "mongoose";

/**
 * El guion de la encuesta telefónica: lo que dice la asistente de voz, palabra
 * por palabra, y las preguntas con sus opciones.
 *
 * Las preguntas viven adentro del cuestionario y no en su propia colección:
 * siempre se leen y se guardan juntas, y cada una conserva su `_id`, que es lo
 * que las respuestas de cada llamada usan para apuntarle.
 */
const PreguntaSchema = new Schema({
  /** El nombre del campo que extrae el agente de voz para esta pregunta (p. ej. «gobierno»). */
  clave: { type: String, required: true },
  texto: { type: String, required: true },
  /** Cómo se rotula en el tablero. */
  corto: { type: String, default: null },
  tipo: { type: String, default: "OPCION_UNICA" },
  /** Las respuestas posibles, en el orden en que se leen. */
  opciones: { type: [String], default: [] },
  /** Respuestas que se registran pero no se dicen en voz alta («No sabe»). */
  noSeLeen: { type: [String], default: [] },
  /** Indicaciones extra para la asistente en esta pregunta, una por renglón. */
  reglas: { type: String, default: null },
  orden: { type: Number, default: 0 },
});

const EncuestaCuestionarioSchema = new Schema(
  {
    nombre: { type: String, required: true },
    saludo: { type: String, required: true },
    cierre: { type: String, default: null },
    municipio: { type: String, default: null },
    activo: { type: Boolean, default: true },
    /** JSON: lo que contesta la asistente en cada situación (no quiere participar, quién habla…). */
    frases: { type: String, default: null },
    /** Sube cada vez que alguien cambia el guion: cada llamada guarda con qué versión se hizo. */
    version: { type: Number, default: 1 },
    preguntas: { type: [PreguntaSchema], default: [] },
    /**
     * Marca del cuestionario que se crea solo la primera vez que alguien abre
     * Encuestas. Es única para que dos pantallas abriéndose a la vez no creen
     * dos.
     */
    semilla: { type: String, default: undefined },
  },
  { timestamps: true, collection: "encuestas_cuestionarios" },
);

EncuestaCuestionarioSchema.index({ semilla: 1 }, { unique: true, sparse: true });
EncuestaCuestionarioSchema.index({ activo: 1, createdAt: -1 });

export default models.EncuestaCuestionario ?? model("EncuestaCuestionario", EncuestaCuestionarioSchema);
