import type { Evidenced } from "@offerly/types";

/**
 * Profile field-path utilities (spec 003 §FR-1/§FR-4). Paths use the same
 * dot/bracket notation the S2 verifier emits ("skills.databases[0]",
 * "headline.total_years_experience", "roles[1].end") and are shared by S3
 * adjudication (T2.3), user corrections (T2.5) and the user-merge step.
 */

export type PathToken = string | number;

const PATH_SEGMENT = /([^.[\]]+)|\[(\d+)\]/g;

/** Parse "roles[1].end" → ["roles", 1, "end"]. Returns null on malformed input. */
export function parseProfilePath(path: string): PathToken[] | null {
  if (path.length === 0 || path.length > 200) return null;
  const tokens: PathToken[] = [];
  for (const match of path.matchAll(PATH_SEGMENT)) {
    if (match[1] !== undefined) tokens.push(match[1]);
    else tokens.push(Number(match[2]));
  }
  // Every character must be covered by segments joined with dots.
  const rebuilt = tokens
    .map((t, i) => (typeof t === "number" ? `[${t}]` : i === 0 ? t : `.${t}`))
    .join("");
  if (rebuilt !== path || tokens.length === 0) return null;
  return tokens;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural check: an object carrying the Evidenced leaf shape. */
export function isEvidencedLeaf(value: unknown): value is Evidenced<unknown> {
  return (
    isRecord(value) &&
    "value" in value &&
    "status" in value &&
    "confidence" in value &&
    "evidence" in value
  );
}

interface ResolvedLeaf {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  leaf: Evidenced<unknown>;
}

function resolve(root: unknown, tokens: PathToken[]): ResolvedLeaf | null {
  let node: unknown = root;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    if (token === undefined) return null;
    if (typeof token === "number") {
      if (!Array.isArray(node)) return null;
      node = node[token];
    } else {
      if (!isRecord(node)) return null;
      node = node[token];
    }
    if (node === undefined || node === null) return null;
  }
  const last = tokens[tokens.length - 1];
  if (last === undefined) return null;
  if (typeof last === "number") {
    if (!Array.isArray(node)) return null;
    const leaf = node[last];
    if (!isEvidencedLeaf(leaf)) return null;
    return { parent: node, key: last, leaf };
  }
  if (!isRecord(node)) return null;
  const leaf = node[last];
  if (!isEvidencedLeaf(leaf)) return null;
  return { parent: node, key: last, leaf };
}

/** Resolve a verifier-style path to its Evidenced leaf; null when absent. */
export function getEvidencedAtPath(root: unknown, path: string): Evidenced<unknown> | null {
  const tokens = parseProfilePath(path);
  if (!tokens) return null;
  return resolve(root, tokens)?.leaf ?? null;
}

export const UNKNOWN_LEAF: Evidenced<unknown> = {
  value: null,
  status: "unknown",
  confidence: 0,
  evidence: null,
};

/**
 * S3 'drop' (T2.3): array elements are removed; scalar leaves become UNKNOWN
 * (spec §FR-2: silence is explicit, never omission). Returns false when the
 * path does not resolve to an Evidenced leaf.
 */
export function dropAtPath(root: unknown, path: string): boolean {
  const tokens = parseProfilePath(path);
  if (!tokens) return false;
  const resolved = resolve(root, tokens);
  if (!resolved) return false;
  if (Array.isArray(resolved.parent) && typeof resolved.key === "number") {
    resolved.parent.splice(resolved.key, 1);
  } else {
    (resolved.parent as Record<string, unknown>)[resolved.key] = { ...UNKNOWN_LEAF };
  }
  return true;
}

/**
 * S3 'correct' (T2.3): overwrite value/evidence in place. Confidence is left
 * untouched — re-clamping is not S3's job (S2 already ran).
 */
export function correctAtPath(root: unknown, path: string, value: unknown, evidence: string): boolean {
  const tokens = parseProfilePath(path);
  if (!tokens) return false;
  const resolved = resolve(root, tokens);
  if (!resolved) return false;
  resolved.leaf.value = value;
  resolved.leaf.evidence = evidence;
  resolved.leaf.status = "stated";
  return true;
}

/**
 * User correction (spec §FR-4, T2.5): the user's statement needs no evidence —
 * stated, confidence 1, source 'user', distinguishable forever from AI facts.
 * Mutates the leaf in place (array-element metadata like years/recency kept).
 * Returns false when the path does not resolve to an Evidenced leaf.
 */
export function setUserValueAtPath(root: unknown, path: string, value: unknown): boolean {
  const tokens = parseProfilePath(path);
  if (!tokens) return false;
  const resolved = resolve(root, tokens);
  if (!resolved) return false;
  resolved.leaf.value = value;
  resolved.leaf.status = "stated";
  resolved.leaf.confidence = 1;
  resolved.leaf.evidence = null;
  resolved.leaf.source = "user";
  return true;
}
