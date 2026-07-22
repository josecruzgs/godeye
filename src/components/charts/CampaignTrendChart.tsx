"use client";

import { useState } from "react";
import { ResponsiveContainer, LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip } from "recharts";
import type { TooltipContentProps } from "recharts";

export type TrendPoint = { day: string; label: string; likes: number; comments: number };

function ChartTooltip({ active, payload, label }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-hairline bg-surface px-3 py-2 text-xs shadow-md">
      <p className="mb-1.5 font-medium text-ink-secondary">{label}</p>
      <div className="flex flex-col gap-1">
        {payload.map((p) => (
          <div key={String(p.dataKey)} className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="font-semibold text-ink">{p.value}</span>
            <span className="text-ink-muted">{p.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function CampaignTrendChart({ data }: { data: TrendPoint[] }) {
  const [showTable, setShowTable] = useState(false);
  const totalLikes = data.reduce((s, d) => s + d.likes, 0);
  const totalComments = data.reduce((s, d) => s + d.comments, 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-4 text-xs text-ink-secondary">
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--series-1)" }} />
            Likes completados
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: "var(--series-2)" }} />
            Comentarios completados
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowTable((s) => !s)}
          className="text-xs text-ink-muted underline hover:text-ink"
        >
          {showTable ? "Ver gráfico" : "Ver como tabla"}
        </button>
      </div>

      {showTable ? (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-hairline">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-surface text-left text-ink-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Día</th>
                <th className="px-3 py-2 font-medium">Likes</th>
                <th className="px-3 py-2 font-medium">Comentarios</th>
              </tr>
            </thead>
            <tbody>
              {data.map((d) => (
                <tr key={d.day} className="border-t border-hairline">
                  <td className="px-3 py-1.5 text-ink-secondary">{d.label}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink">{d.likes}</td>
                  <td className="px-3 py-1.5 tabular-nums text-ink">{d.comments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : totalLikes === 0 && totalComments === 0 ? (
        <div className="flex h-64 items-center justify-center text-sm text-ink-muted">
          Todavía no hay campañas completadas en estos 14 días.
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--gridline)" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={{ stroke: "var(--baseline)" }}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              minTickGap={24}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--text-muted)", fontSize: 11 }}
              width={28}
              allowDecimals={false}
            />
            <Tooltip content={ChartTooltip} cursor={{ stroke: "var(--baseline)", strokeWidth: 1 }} />
            <Line
              type="linear"
              dataKey="likes"
              name="Likes"
              stroke="var(--series-1)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, stroke: "var(--surface-1)", strokeWidth: 2 }}
            />
            <Line
              type="linear"
              dataKey="comments"
              name="Comentarios"
              stroke="var(--series-2)"
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 5, stroke: "var(--surface-1)", strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
