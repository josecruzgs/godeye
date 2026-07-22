import { NextResponse } from "next/server";
import { decodo, type DecodoSubscription } from "@/lib/decodo/client";
import { withApiErrors } from "@/lib/apiHandler";

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

// Los nombres de campo exactos de la respuesta real no están confirmados
// todavía (la documentación pública no los detalla del todo) — se prueban
// varios alias comunes hasta que se confirme contra una respuesta real.
function normalize(sub: DecodoSubscription) {
  const limit = num(sub.traffic_limit) ?? num(sub.trafficLimit);
  const used = num(sub.traffic_used) ?? num(sub.trafficUsed) ?? num(sub.used_traffic);
  const remaining = num(sub.traffic_remaining) ?? num(sub.remaining_traffic) ?? num(sub.remaining);
  const available = remaining ?? (limit !== null && used !== null ? limit - used : null);

  return {
    serviceType: sub.service_type ?? sub.serviceType ?? null,
    limitGB: limit,
    usedGB: used,
    availableGB: available,
    percentUsed: limit && limit > 0 && used !== null ? Math.round((used / limit) * 1000) / 10 : null,
    validFrom: sub.valid_from ?? sub.validFrom ?? null,
    validUntil: sub.valid_until ?? sub.validUntil ?? null,
    raw: sub,
  };
}

export const GET = withApiErrors(async () => {
  const data = await decodo.getSubscriptions();
  const subscriptions = Array.isArray(data) ? data : [data];
  return NextResponse.json({ subscriptions: subscriptions.map(normalize) });
});
