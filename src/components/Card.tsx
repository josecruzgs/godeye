export default function Card({
  className = "",
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-2xl border border-hairline bg-surface/70 shadow-sm backdrop-blur-xl ${className}`}>
      {children}
    </div>
  );
}
