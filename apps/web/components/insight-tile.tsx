import { Card, CardBody } from "@/components/card";

const tones = {
  default: "text-neutral-900",
  warn: "text-amber-700",
} as const;

export function InsightTile({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  /** Already formatted by the caller — "—" when the value is unknown. */
  value: string;
  hint?: string;
  tone?: keyof typeof tones;
}) {
  return (
    <Card>
      <CardBody className="flex flex-col gap-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">{label}</p>
        <p className={`text-2xl font-bold tabular-nums ${tones[tone]}`}>{value}</p>
        {hint && <p className="text-xs text-neutral-500">{hint}</p>}
      </CardBody>
    </Card>
  );
}
