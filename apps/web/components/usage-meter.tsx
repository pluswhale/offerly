import type { UsageSummary } from "@offerly/types";

/** AI quota display. The API serializes Infinity as -1 (see UsageSummary). */
export function UsageMeter({ usage }: { usage: UsageSummary }) {
  const limit = usage.limits.ai_requests_per_month;
  const used = usage.ai_requests_this_month;
  const unlimited = limit < 0;
  const pct = unlimited ? 0 : Math.min(100, (used / Math.max(1, limit)) * 100);
  const nearLimit = !unlimited && used >= limit * 0.8;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium text-neutral-700">AI requests this month</span>
        <span className="tabular-nums text-neutral-500">
          {unlimited ? (
            <>{used} used · Unlimited ({usage.plan})</>
          ) : (
            <>
              {used} / {limit} used
            </>
          )}
        </span>
      </div>
      {!unlimited && (
        <div
          className="h-2 w-full overflow-hidden rounded-full bg-neutral-200"
          role="progressbar"
          aria-valuenow={used}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-label="AI request quota"
        >
          <div
            className={`h-full rounded-full transition-[width] ${
              nearLimit ? "bg-amber-500" : "bg-accent-600"
            }`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}
