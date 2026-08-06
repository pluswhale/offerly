"use client";

import { useState } from "react";
import type { Evidenced } from "@offerly/types";
import { Badge } from "./badge";

/**
 * One Evidenced leaf of the Candidate Profile (spec 003 §FR-2/§FR-4, T2.7):
 * value + status badge + expandable verbatim evidence + inline edit (PATCH).
 */

export type FieldEditor =
  | { kind: "text" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "select"; options: readonly string[] };

interface ProfileFieldProps {
  /** Row label; omit for chip-style rendering (skills, industries…). */
  label?: string;
  leaf: Evidenced<unknown>;
  /** Verifier-style PATCH path, e.g. "skills.databases[0]" (spec §FR-4). */
  path: string;
  editor: FieldEditor;
  onPatch: (path: string, value: unknown) => Promise<void>;
}

function displayValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function draftFrom(leaf: Evidenced<unknown>): string {
  return leaf.value === null ? "" : String(leaf.value);
}

/** Status badge per spec: User-set > Contradicted > Low confidence > Verified. */
function LeafBadge({ leaf }: { leaf: Evidenced<unknown> }) {
  if (leaf.status === "unknown" || leaf.value === null) {
    return <Badge>Unknown</Badge>;
  }
  if (leaf.source === "user") return <Badge tone="blue">User-set</Badge>;
  if (leaf.status === "contradicted") return <Badge tone="red">Contradicted</Badge>;
  if (leaf.confidence <= 0.4) return <Badge tone="amber">Low confidence</Badge>;
  return <Badge tone="green">Verified</Badge>;
}

function PencilIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      className="size-4"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M14.5 3.5a1.7 1.7 0 0 1 2.4 2.4l-9.6 9.6-3.4 1 1-3.4 9.6-9.6Z"
      />
    </svg>
  );
}

export function ProfileField({ label, leaf, path, editor, onPatch }: ProfileFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);

  const unknown = leaf.status === "unknown" || leaf.value === null;
  const editLabel = label ? `Edit ${label}` : `Edit ${draftFrom(leaf) || "value"}`;

  function startEdit() {
    setDraft(draftFrom(leaf));
    setError(null);
    setEditing(true);
  }

  async function save() {
    let value: unknown = draft.trim();
    if (editor.kind === "number") {
      const n = Number(draft);
      if (draft.trim() === "" || Number.isNaN(n)) {
        setError("Enter a number.");
        return;
      }
      value = n;
    } else if (editor.kind === "boolean") {
      value = draft === "true";
    }
    setSaving(true);
    setError(null);
    try {
      await onPatch(path, value);
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save — try again.");
    } finally {
      setSaving(false);
    }
  }

  const editorControl =
    editor.kind === "select" ? (
      <select
        aria-label={editLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-accent-600"
      >
        {draft === "" && <option value="">Choose…</option>}
        {editor.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : editor.kind === "boolean" ? (
      <select
        aria-label={editLabel}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 focus-visible:outline-2 focus-visible:outline-accent-600"
      >
        {draft === "" && <option value="">Choose…</option>}
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    ) : (
      <input
        aria-label={editLabel}
        type={editor.kind === "number" ? "number" : "text"}
        inputMode={editor.kind === "number" ? "decimal" : undefined}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setEditing(false);
        }}
        className="min-h-11 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm text-neutral-900 placeholder:text-neutral-400 focus-visible:outline-2 focus-visible:outline-accent-600"
      />
    );

  if (editing) {
    return (
      <div className="flex flex-col gap-2 py-2">
        {label && <p className="text-sm font-medium text-neutral-700">{label}</p>}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">{editorControl}</div>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-accent-600 px-3 text-sm font-medium text-white hover:bg-accent-700 disabled:bg-accent-300"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            disabled={saving}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Cancel
          </button>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="flex items-start justify-between gap-2">
        {label && (
          <p className="min-w-0 shrink-0 basis-28 text-sm font-medium text-neutral-700">
            {label}
          </p>
        )}
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-x-2 gap-y-1">
          {unknown ? (
            <span className="text-sm italic text-neutral-400">Not stated in CV</span>
          ) : (
            <span className="text-sm break-words text-neutral-900">
              {displayValue(leaf.value)}
            </span>
          )}
          <LeafBadge leaf={leaf} />
          {leaf.evidence && (
            <button
              type="button"
              onClick={() => setShowEvidence((v) => !v)}
              aria-expanded={showEvidence}
              className="inline-flex min-h-11 cursor-pointer items-center rounded-lg px-2 text-xs font-medium text-accent-700 hover:bg-accent-50"
            >
              {showEvidence ? "Hide evidence" : "Evidence"}
            </button>
          )}
          <button
            type="button"
            onClick={startEdit}
            aria-label={editLabel}
            className="inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
          >
            <PencilIcon />
          </button>
        </div>
      </div>
      {showEvidence && leaf.evidence && (
        <blockquote className="mt-1 border-l-2 border-accent-200 pl-3 text-sm italic text-neutral-600">
          &ldquo;{leaf.evidence}&rdquo;
        </blockquote>
      )}
    </div>
  );
}
