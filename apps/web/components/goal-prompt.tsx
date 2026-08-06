"use client";

import { useState } from "react";
import type { Profile, UpdateProfileRequest, UserGoals } from "@offerly/types";
import { api } from "@/lib/api";
import { Button } from "./button";
import { Input } from "./input";

export type GoalField = keyof UserGoals;

const DEFAULT_FIELDS: readonly GoalField[] = ["target_location", "target_salary", "priority"];

const FIELD_META: Record<
  GoalField,
  { label: string; question: string; hint: string; placeholder?: string }
> = {
  target_location: {
    label: "Target location",
    question: "Where would you like to work?",
    hint: "Match scores and the coach weigh location fit.",
    placeholder: "e.g. Berlin, remote EU",
  },
  target_salary: {
    label: "Target salary",
    question: "What's your target salary?",
    hint: "Helps the coach ground negotiation advice.",
  },
  priority: {
    label: "Top priority",
    question: "What matters most in your next role?",
    hint: "The coach weighs this when comparing options.",
    placeholder: "e.g. remote work, growth, visa sponsorship",
  },
};

function dismissedKey(field: GoalField): string {
  return `offerly:goal-prompt-dismissed:${field}`;
}

function readDismissed(field: GoalField): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(dismissedKey(field)) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(field: GoalField): void {
  try {
    window.localStorage.setItem(dismissedKey(field), "1");
  } catch {
    // Private mode etc. — dismissal just won't persist.
  }
}

/**
 * Progressive profiling for user goals (spec 003 §FR-11, T4.4): asks for one
 * missing user_goals field inline, at the moment a feature benefits from it —
 * never a blocking form. Renders nothing when every candidate field is filled
 * or was skipped; "Skip" is persisted so we don't nag. The null-check on
 * profile.user_goals is the source of truth for asking.
 */
export function GoalPrompt({
  profile,
  fields = DEFAULT_FIELDS,
  onSaved,
}: {
  profile: Profile | null;
  /** Fields to ask about, in priority order — the first unanswered one is asked. */
  fields?: readonly GoalField[];
  onSaved?: (profile: Profile) => void;
}) {
  const [text, setText] = useState("");
  const [salaryAmount, setSalaryAmount] = useState("");
  const [salaryCurrency, setSalaryCurrency] = useState("");
  const [salaryPeriod, setSalaryPeriod] = useState<"year" | "month" | "hour">("year");
  const [saving, setSaving] = useState(false);
  const [skipped, setSkipped] = useState<readonly GoalField[]>([]);
  const [done, setDone] = useState(false);

  if (!profile || done) return null;
  const field = fields.find(
    (f) => profile.user_goals?.[f] == null && !skipped.includes(f) && !readDismissed(f),
  );
  if (!field) return null;

  const meta = FIELD_META[field];

  const skip = () => {
    writeDismissed(field);
    setSkipped((s) => [...s, field]);
  };

  /** null ⇔ the current input isn't a complete answer yet. */
  function buildGoalsPatch(): Partial<UserGoals> | null {
    if (field === "target_salary") {
      const amount = Number(salaryAmount);
      const currency = salaryCurrency.trim().toUpperCase();
      if (!Number.isFinite(amount) || amount <= 0 || !currency) return null;
      return { target_salary: { amount, currency, period: salaryPeriod } };
    }
    const value = text.trim();
    if (!value) return null;
    return field === "target_location" ? { target_location: value } : { priority: value };
  }

  async function save() {
    const goals = buildGoalsPatch();
    if (!goals) return;
    setSaving(true);
    try {
      const updated = await api<Profile>("/profiles/me", {
        method: "PATCH",
        json: { user_goals: goals } satisfies UpdateProfileRequest,
      });
      setDone(true);
      onSaved?.(updated);
    } catch {
      // Non-fatal: the feature still works without this field.
      skip();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-accent-200 bg-accent-50 p-4">
      <p className="text-sm font-medium text-neutral-900">{meta.question}</p>
      <p className="mt-0.5 text-sm text-neutral-600">{meta.hint}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        {field === "target_salary" ? (
          <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-[1fr_6rem_7rem]">
            <div className="col-span-2 sm:col-span-1">
              <Input
                label={meta.label}
                type="number"
                min={0}
                inputMode="numeric"
                value={salaryAmount}
                onChange={(e) => setSalaryAmount(e.target.value)}
                placeholder="90000"
              />
            </div>
            <Input
              label="Currency"
              value={salaryCurrency}
              onChange={(e) => setSalaryCurrency(e.target.value)}
              placeholder="EUR"
              maxLength={3}
            />
            <div className="flex flex-col gap-1.5">
              <label htmlFor="goal-salary-period" className="text-sm font-medium text-neutral-700">
                Per
              </label>
              <select
                id="goal-salary-period"
                value={salaryPeriod}
                onChange={(e) => setSalaryPeriod(e.target.value as "year" | "month" | "hour")}
                className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-accent-600"
              >
                <option value="year">year</option>
                <option value="month">month</option>
                <option value="hour">hour</option>
              </select>
            </div>
          </div>
        ) : (
          <div className="flex-1">
            <Input
              label={meta.label}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={meta.placeholder}
            />
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={save} loading={saving} disabled={buildGoalsPatch() === null}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={skip}>
            Skip
          </Button>
        </div>
      </div>
    </div>
  );
}
