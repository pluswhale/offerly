/** 0–100 score displayed as a progress ring. */
export function ScoreRing({
  score,
  size = 96,
  label,
}: {
  score: number;
  size?: number;
  label?: string;
}) {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const stroke = size >= 96 ? 8 : 6;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);

  const color =
    clamped >= 70
      ? "text-emerald-600"
      : clamped >= 40
        ? "text-amber-500"
        : "text-red-500";

  return (
    <div
      className="relative inline-flex items-center justify-center"
      role="img"
      aria-label={`Score: ${clamped} out of 100`}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-neutral-200"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className={`stroke-current transition-[stroke-dashoffset] duration-700 ${color}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-bold tabular-nums ${size >= 96 ? "text-2xl" : "text-lg"} ${color}`}>
          {clamped}
        </span>
        {label && <span className="text-[10px] text-neutral-500">{label}</span>}
      </div>
    </div>
  );
}
