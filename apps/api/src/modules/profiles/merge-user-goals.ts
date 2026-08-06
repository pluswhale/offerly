import type { UserGoals } from "@offerly/types";

/**
 * Partial merge for progressive profiling (spec 003 §FR-11, T4.4): only keys
 * present in the patch are written — unset keys keep their stored values, an
 * explicit null clears a key.
 */
export function mergeUserGoals(
  existing: UserGoals | null,
  patch: Partial<UserGoals>,
): UserGoals {
  const merged: UserGoals = {
    target_location: existing?.target_location ?? null,
    target_salary: existing?.target_salary ?? null,
    priority: existing?.priority ?? null,
  };
  if (patch.target_location !== undefined) merged.target_location = patch.target_location;
  if (patch.target_salary !== undefined) merged.target_salary = patch.target_salary;
  if (patch.priority !== undefined) merged.priority = patch.priority;
  return merged;
}
