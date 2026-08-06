import type { HealthItemDraft } from "./types.js";

/**
 * P2 — Technology adjacency questions (spec 003 §FR-14, T5.5). Some skills
 * almost always travel together (Express runs on Node.js, Django is Python).
 * When the profile lists skill A but not its adjacent skill B, that is
 * either an extraction gap or a real CV gap — so the detector ASKS:
 * every item is phrased as a question, severity info, and the detail says
 * explicitly that nothing is changed automatically. The profile is never
 * mutated: the detector only reads the canonical skill set.
 *
 * The pairs are curated, not derived — only clearly-defensible adjacencies
 * belong here. Skill names are canonical alias forms (aliases.ts); labels
 * are the display spellings used in the user-facing text.
 */

export interface AdjacencyPair {
  /** Canonical form of the skill the profile lists. */
  listed: string;
  /** Canonical form of the adjacent skill that may be missing. */
  adjacent: string;
  listedLabel: string;
  adjacentLabel: string;
  /** One short clause explaining why the two travel together. */
  reason: string;
}

export const TECH_ADJACENCY_PAIRS: readonly AdjacencyPair[] = [
  { listed: "express", adjacent: "node.js", listedLabel: "Express", adjacentLabel: "Node.js", reason: "Express is a Node.js framework" },
  { listed: "nestjs", adjacent: "node.js", listedLabel: "NestJS", adjacentLabel: "Node.js", reason: "NestJS runs on Node.js" },
  { listed: "react", adjacent: "javascript", listedLabel: "React", adjacentLabel: "JavaScript", reason: "React is a JavaScript library" },
  { listed: "next.js", adjacent: "react", listedLabel: "Next.js", adjacentLabel: "React", reason: "Next.js is built on React" },
  { listed: "angular", adjacent: "typescript", listedLabel: "Angular", adjacentLabel: "TypeScript", reason: "Angular is written in TypeScript" },
  { listed: "vue.js", adjacent: "javascript", listedLabel: "Vue", adjacentLabel: "JavaScript", reason: "Vue is a JavaScript framework" },
  { listed: "django", adjacent: "python", listedLabel: "Django", adjacentLabel: "Python", reason: "Django is a Python framework" },
  { listed: "flask", adjacent: "python", listedLabel: "Flask", adjacentLabel: "Python", reason: "Flask is a Python framework" },
  { listed: "fastapi", adjacent: "python", listedLabel: "FastAPI", adjacentLabel: "Python", reason: "FastAPI is a Python framework" },
  { listed: "ruby on rails", adjacent: "ruby", listedLabel: "Rails", adjacentLabel: "Ruby", reason: "Rails is a Ruby framework" },
  { listed: "spring boot", adjacent: "java", listedLabel: "Spring Boot", adjacentLabel: "Java", reason: "Spring Boot is a Java framework" },
  { listed: "spring", adjacent: "java", listedLabel: "Spring", adjacentLabel: "Java", reason: "Spring is a Java framework" },
  { listed: "laravel", adjacent: "php", listedLabel: "Laravel", adjacentLabel: "PHP", reason: "Laravel is a PHP framework" },
  { listed: "symfony", adjacent: "php", listedLabel: "Symfony", adjacentLabel: "PHP", reason: "Symfony is a PHP framework" },
  { listed: "postgresql", adjacent: "sql", listedLabel: "PostgreSQL", adjacentLabel: "SQL", reason: "PostgreSQL is queried in SQL" },
  { listed: "mysql", adjacent: "sql", listedLabel: "MySQL", adjacentLabel: "SQL", reason: "MySQL is queried in SQL" },
  { listed: "mongodb", adjacent: "nosql", listedLabel: "MongoDB", adjacentLabel: "NoSQL", reason: "MongoDB is a NoSQL database" },
  { listed: "kubernetes", adjacent: "docker", listedLabel: "Kubernetes", adjacentLabel: "Docker", reason: "Kubernetes orchestrates Docker containers" },
];

/** Cap on question items per run — beyond this the list reads as nagging. */
const MAX_ITEMS = 5;

/**
 * Emit one question per pair where `listed` is present and `adjacent` is
 * not. Pure: reads the set, never writes it (safe on a frozen set).
 */
export function detectTechAdjacency(
  canonicalSkills: ReadonlySet<string>,
): HealthItemDraft[] {
  const items: HealthItemDraft[] = [];
  for (const pair of TECH_ADJACENCY_PAIRS) {
    if (items.length >= MAX_ITEMS) break;
    if (!canonicalSkills.has(pair.listed) || canonicalSkills.has(pair.adjacent)) continue;
    items.push({
      detector: "tech_adjacency",
      severity: "info",
      title: `You list ${pair.listedLabel} but not ${pair.adjacentLabel} — do you use it?`,
      detail:
        `${pair.reason}, so recruiters and ATS keyword checks usually expect ` +
        `both. If you genuinely work with ${pair.adjacentLabel}, add it to your ` +
        "skills — if not, dismiss this. Nothing is changed automatically: this " +
        "is a question, not an edit.",
    });
  }
  return items;
}
