// El campo "remark" de AdsPower es texto libre donde se anota a mano la edad
// y el género del perfil (ej. "25 Hombre", "Mujer, 30 años"). Se parsea una
// sola vez al sincronizar/crear el perfil y se guarda en campos propios
// (Profile.age / Profile.gender) para poder filtrar por rango de edad y
// género sin tener que re-parsear texto libre en cada query.
export type Gender = "hombre" | "mujer";

const GENDER_PATTERNS: { pattern: RegExp; gender: Gender }[] = [
  { pattern: /\b(hombre|male|man)\b/i, gender: "hombre" },
  { pattern: /\b(mujer|female|woman)\b/i, gender: "mujer" },
];

export function parseRemark(remark: string): { age: number | null; gender: Gender | null } {
  const ageMatch = remark.match(/\b(\d{1,3})\b/);
  const age = ageMatch ? Number(ageMatch[1]) : null;

  let gender: Gender | null = null;
  for (const { pattern, gender: g } of GENDER_PATTERNS) {
    if (pattern.test(remark)) {
      gender = g;
      break;
    }
  }

  return { age, gender };
}
