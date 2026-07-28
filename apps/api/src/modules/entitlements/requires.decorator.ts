import { SetMetadata } from "@nestjs/common";

export const REQUIRES_FEATURE_KEY = "requiresFeature";

export type GatedFeature =
  | "cv_create"
  | "cv_analysis"
  | "job_match"
  | "apply_generate"
  | "coach"
  | "application_create"
  | "application_modify";

/** Declares the plan-gated feature an endpoint needs (T10.2). */
export const Requires = (feature: GatedFeature) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);
