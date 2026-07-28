"use client";

import { useState } from "react";
import type { Profile, UpdateProfileRequest } from "@offerly/types";
import { api } from "@/lib/api";
import { Button } from "./button";
import { Input } from "./input";

export type ProfilingField = "location" | "experience_level" | "visa_status" | "target_role";

const FIELD_META: Record<ProfilingField, { label: string; question: string; placeholder: string }> = {
  location: {
    label: "Location",
    question: "Where are you looking to work?",
    placeholder: "e.g. Berlin, remote EU",
  },
  experience_level: {
    label: "Experience level",
    question: "How much experience do you have?",
    placeholder: "e.g. 3 years, mid-level",
  },
  visa_status: {
    label: "Visa situation",
    question: "Do you need visa sponsorship?",
    placeholder: "e.g. EU citizen, needs sponsorship",
  },
  target_role: {
    label: "Target role",
    question: "What role are you aiming for?",
    placeholder: "e.g. Senior Frontend Engineer",
  },
};

/**
 * Progressive profiling prompt (T3.2): asks for one missing profile field
 * inline, at the moment a feature needs it — never during onboarding.
 * Renders nothing when the field is already filled.
 */
export function ProgressiveProfilePrompt({
  profile,
  field,
  reason,
  onSaved,
}: {
  profile: Profile | null;
  field: ProfilingField;
  /** Why we're asking, shown to the user. */
  reason: string;
  onSaved?: (profile: Profile) => void;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [saved, setSaved] = useState(false);

  if (!profile || profile[field] || dismissed || saved) return null;

  const meta = FIELD_META[field];

  async function save() {
    if (!value.trim()) return;
    setSaving(true);
    try {
      const updated = await api<Profile>("/profiles/me", {
        method: "PATCH",
        json: { [field]: value.trim() } satisfies UpdateProfileRequest,
      });
      setSaved(true);
      onSaved?.(updated);
    } catch {
      // Non-fatal: the feature still works without this field.
      setDismissed(true);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-accent-200 bg-accent-50 p-4">
      <p className="text-sm font-medium text-neutral-900">{meta.question}</p>
      <p className="mt-0.5 text-sm text-neutral-600">{reason}</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Input
            label={meta.label}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={meta.placeholder}
          />
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={save} loading={saving} disabled={!value.trim()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}
