export default function Meter({
  label,
  value,
  total,
  valueLabel,
}: {
  label: string;
  value: number;
  total: number;
  valueLabel?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-ink-secondary">{label}</p>
        <p className="text-sm font-medium text-ink">{valueLabel ?? `${value} / ${total}`}</p>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--seq-100)]">
        <div
          className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
