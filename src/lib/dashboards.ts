import crypto from "crypto";

export function generateShareToken() {
  return crypto.randomBytes(9).toString("base64url");
}
