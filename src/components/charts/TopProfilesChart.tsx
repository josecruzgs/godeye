"use client";

import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, LabelList } from "recharts";
import type { TooltipContentProps } from "recharts";

export type ProfileRow = { name: string; count: number };

function BarTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-ink">{p.value} completados</p>
      <p className="text-ink-muted">{(p.payload as ProfileRow).name}</p>
    </div>
  );
}

export default function TopProfilesChart({ data }: { data: ProfileRow[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-56 items-center justify-center text-sm text-ink-muted">
        Aún no hay likes o comentarios exitosos.
      </div>
    );
  }

  const height = Math.max(140, data.length * 40);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 28, left: 4, bottom: 4 }} barCategoryGap="30%">
        <XAxis type="number" hide allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="name"
          width={110}
          tickLine={false}
          axisLine={false}
          tick={{ fill: "var(--text-secondary)", fontSize: 12 }}
        />
        <Tooltip content={BarTooltip} cursor={{ fill: "var(--page-plane)" }} />
        <Bar dataKey="count" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={20}>
          <LabelList dataKey="count" position="right" style={{ fill: "var(--text-secondary)", fontSize: 12 }} />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
