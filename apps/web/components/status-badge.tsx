import type { ApplicationStatus } from "@offerly/types";
import { Badge } from "./badge";

const config: Record<
  ApplicationStatus,
  { label: string; tone: "neutral" | "blue" | "amber" | "green" | "red" }
> = {
  saved: { label: "Saved", tone: "neutral" },
  applied: { label: "Applied", tone: "blue" },
  interview: { label: "Interview", tone: "amber" },
  offer: { label: "Offer", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
};

export function StatusBadge({ status }: { status: ApplicationStatus }) {
  const c = config[status];
  return <Badge tone={c.tone}>{c.label}</Badge>;
}
