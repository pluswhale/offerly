import type { CandidateProfile, Evidenced } from "@offerly/types";
import { collectCandidateProfileEvidenced } from "./evidence.js";
import {
  getEvidencedAtPath,
  parseProfilePath,
  setUserValueAtPath,
} from "./profile-paths.js";
import { normalizeForMatch } from "./text.js";

/**
 * User-correction preservation (spec 003 §FR-4, T2.5). User-sourced facts are
 * the user's statements — they win over freshly extracted AI facts at the same
 * position on every pipeline re-run.
 */

/** PATCH /cvs/:id/profile: set one field as a user statement. False → 400. */
export function applyUserCorrection(
  profile: CandidateProfile,
  path: string,
  value: unknown,
): boolean {
  return setUserValueAtPath(profile, path, value);
}

type EvidencedArray = Evidenced<unknown>[];

function keyOf(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? normalizeForMatch(value) : null;
}

/** Replace the element with the same natural key in place, else append. */
function upsertByValue(array: EvidencedArray, userLeaf: Evidenced<unknown>): void {
  const key = keyOf(userLeaf.value);
  const index = key ? array.findIndex((item) => keyOf(item.value) === key) : -1;
  if (index >= 0) array[index] = structuredClone(userLeaf);
  else array.push(structuredClone(userLeaf));
}

/** All non-null string values among the given Evidenced fields of an object. */
function elementKeys(record: Record<string, unknown>, fields: string[]): Set<string> {
  const keys = new Set<string>();
  for (const field of fields) {
    const leaf = record[field];
    if (
      typeof leaf === "object" &&
      leaf !== null &&
      "value" in leaf &&
      typeof (leaf as { value: unknown }).value === "string"
    ) {
      const key = keyOf((leaf as { value: unknown }).value);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * Merge user-sourced facts from the previous profile into a freshly extracted
 * one. Returns the number of preserved fields.
 *
 * Array identity (simplest correct approach, T2.5): elements match on their
 * natural key, never on the raw index — extraction may reorder or split
 * entries between runs.
 *   skills.<group>[i] / experience.industries[i] / domains[i] /
 *     location.work_authorization[i]  → the element's own value (skill name…)
 *   roles[i].<field>                  → any of company / title
 *   education[i].<field>              → any of institution / degree
 *   certifications[i].<field>         → name
 *   languages[i].<field>              → language
 * (Several key fields per section because the corrected field may itself be
 * the primary key — e.g. a renamed company still matches via the title.)
 * Matched elements are replaced in place; unmatched whole-element corrections
 * are appended; unmatched sub-field corrections are dropped (there is no
 * honest position for them). Scalar paths overwrite the leaf directly.
 */
export function mergeUserCorrections(
  previous: CandidateProfile,
  next: CandidateProfile,
): number {
  let preserved = 0;

  for (const { path, item } of collectCandidateProfileEvidenced(previous)) {
    if (item.source !== "user") continue;
    const tokens = parseProfilePath(path);
    if (!tokens) continue;

    const applied =
      tokens.every((t) => typeof t === "string")
        ? mergeScalar(next, path, item)
        : mergeArrayEntry(previous, next, tokens, item);
    if (applied) preserved += 1;
  }
  return preserved;
}

function mergeScalar(
  next: CandidateProfile,
  path: string,
  userLeaf: Evidenced<unknown>,
): boolean {
  const leaf = getEvidencedAtPath(next, path);
  if (!leaf) return false;
  Object.assign(leaf, structuredClone(userLeaf));
  return true;
}

/** Object-array natural keys per section (see mergeUserCorrections docs). */
const OBJECT_ARRAY_KEYS = {
  roles: ["company", "title"],
  education: ["institution", "degree"],
  certifications: ["name"],
  languages: ["language"],
} as const;

function mergeArrayEntry(
  previous: CandidateProfile,
  next: CandidateProfile,
  tokens: Array<string | number>,
  userLeaf: Evidenced<unknown>,
): boolean {
  const [section, second, third] = tokens;

  // Whole-element Evidenced arrays: match on the element's own value.
  if (section === "skills" && typeof second === "string" && typeof third === "number") {
    const group = next.skills[second as keyof CandidateProfile["skills"]] as
      | EvidencedArray
      | undefined;
    if (!group) return false;
    upsertByValue(group, userLeaf);
    return true;
  }
  if (
    section === "experience" &&
    (second === "industries" || second === "domains") &&
    typeof third === "number"
  ) {
    upsertByValue(next.experience[second], userLeaf);
    return true;
  }
  if (section === "location" && second === "work_authorization" && typeof third === "number") {
    upsertByValue(next.location.work_authorization, userLeaf);
    return true;
  }

  // Sub-field of an object-array element: match the element by natural key.
  if (
    typeof section === "string" &&
    section in OBJECT_ARRAY_KEYS &&
    typeof second === "number" &&
    typeof third === "string"
  ) {
    const keyFields = OBJECT_ARRAY_KEYS[section as keyof typeof OBJECT_ARRAY_KEYS];
    const previousArray = previous[section as keyof typeof OBJECT_ARRAY_KEYS] as unknown as Array<
      Record<string, unknown>
    >;
    const nextArray = next[section as keyof typeof OBJECT_ARRAY_KEYS] as unknown as Array<
      Record<string, unknown>
    >;
    const sourceElement = previousArray[second];
    if (!sourceElement) return false;
    // Match on ANY key field: the corrected field may itself be the primary
    // key (e.g. a renamed company), so the sibling fields carry the identity.
    const sourceKeys = elementKeys(sourceElement, [...keyFields]);
    const target =
      sourceKeys.size > 0
        ? nextArray.find((element) => {
            const keys = elementKeys(element, [...keyFields]);
            return [...sourceKeys].some((key) => keys.has(key));
          })
        : undefined;
    const leaf = target?.[third];
    if (
      typeof leaf !== "object" ||
      leaf === null ||
      !("value" in leaf) ||
      !("status" in leaf)
    ) {
      return false;
    }
    Object.assign(leaf, structuredClone(userLeaf));
    return true;
  }
  return false;
}
