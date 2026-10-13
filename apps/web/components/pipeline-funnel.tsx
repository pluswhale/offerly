import type { FunnelStage } from "@/lib/pipeline-insights";

function barWidth(count: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.max((count / max) * 100, count > 0 ? 2 : 0)}%`;
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

export function PipelineFunnel({ stages }: { stages: FunnelStage[] }) {
  const max = stages[0]?.count ?? 0;

  return (
    <ol className="flex flex-col gap-2">
      {stages.map((stage, i) => {
        const previous = i === 0 ? undefined : stages[i - 1];
        const conversion = previous ? percent(stage.conversionFromPrevious) : "";
        return (
          <li
            key={stage.key}
            aria-label={`${stage.label}: ${stage.count} application${
              stage.count === 1 ? "" : "s"
            }${previous ? `, ${conversion} from ${previous.label}` : ""}`}
            className="flex items-center gap-2 sm:gap-3"
          >
            <span className="w-16 shrink-0 text-xs font-medium text-neutral-600 sm:w-20">
              {stage.label}
            </span>
            <span className="h-2 min-w-0 flex-1 rounded-full bg-neutral-100">
              <span
                className="block h-2 rounded-full bg-accent-500"
                style={{ width: barWidth(stage.count, max) }}
              />
            </span>
            <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-neutral-900">
              {stage.count}
            </span>
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-neutral-500">
              {conversion}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
