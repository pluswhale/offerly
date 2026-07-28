import type { ReactNode } from "react";

type Tone = "neutral" | "accent" | "green" | "amber" | "red" | "blue";

const tones: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-700",
  accent: "bg-accent-50 text-accent-700",
  green: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  blue: "bg-sky-50 text-sky-700",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
