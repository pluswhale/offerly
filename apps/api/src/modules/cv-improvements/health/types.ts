import type {
  RequirementCategory,
  RequirementImportance,
  RequirementVerdict,
} from "@offerly/types";

/**
 * Shared types for the deterministic CV Health detectors (spec 003 §FR-14,
 * T5.4/T5.5). Every detector is a pure function producing zero or more
 * drafts; the service assigns ids and the initial status before storage. No
 * detector makes an LLM call — the whole health run is free of token cost.
 */

export type HealthDetectorId =
  | "completeness"
  | "missing_keywords"
  | "duplicate_skills"
  | "tense_consistency"
  | "date_format_consistency"
  | "buzzwords"
  | "quantified_achievements"
  | "weak_summary"
  | "tech_adjacency"
  | "ats_format";

export type HealthSeverity = "info" | "warning";

/** Detector output before the service assigns storage fields. */
export interface HealthItemDraft {
  detector: HealthDetectorId;
  severity: HealthSeverity;
  /** One-line headline the UI renders as the item's title. */
  title: string;
  /** Full explanation, phrased as a to-do or question — never auto-applied. */
  detail: string;
  /** Concrete evidence lines (CV excerpts, counts, field paths). */
  examples?: string[];
}

/**
 * One stored health item — the exact per-item JSON the UI renders. `status`
 * matches the sentence/bullet lifecycle so the generic PATCH endpoint can
 * dismiss an item ('rejected'); 'accepted' is allowed but has no extra
 * meaning for health items.
 */
export interface HealthItem extends HealthItemDraft {
  id: string;
  status: "pending" | "accepted" | "rejected";
}

/**
 * Minimal match-report input for the missing-keywords detector — the v2
 * `job_matches.result` verdicts plus the requirement snapshot they reference
 * (StoredMatchResultV2 in jobs/match.service.ts), mapped by the service.
 */
export interface HealthMatchReport {
  jobId: string;
  verdicts: RequirementVerdict[];
  requirements: {
    id: string;
    text: string;
    category: RequirementCategory;
    importance: RequirementImportance;
  }[];
}
