import type {
  CandidateProfile,
  Evidenced,
  JobRequirement,
  RequirementCategory,
  RequirementImportance,
} from "@offerly/types";
import { describe, expect, it, vi } from "vitest";
import { AiService } from "../src/modules/ai/ai.service.js";
import type { LlmProvider } from "../src/modules/ai/llm-provider.js";
import {
  buildProfileProjection,
  matchRequirements,
} from "../src/modules/ai/matching/match-requirements.js";
import {
  createMatchRequirementsTemplate,
  MATCH_REQUIREMENTS_TEMPLATE_VERSION,
  matchRequirementsSystemPrompt,
  type MatchRequirementItem,
} from "../src/modules/ai/prompts/match-requirements.v1.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { fixtureProfile } from "./fixtures/cv-profile.fixture.js";

// Same mock style as cv-validate.spec.ts: queued provider responses + in-memory
// llm_cache/usage_records.
function makeProvider(responses: Array<string | Error>): LlmProvider {
  const queue = [...responses];
  return {
    complete: vi.fn(async () => {
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { content: next ?? "", tokensIn: 100, tokensOut: 50 };
    }),
    stream: vi.fn(),
  };
}

function makeSupabase() {
  const cache = new Map<string, unknown>();
  const usage: Array<Record<string, unknown>> = [];
  const client = {
    from(table: string) {
      if (table === "llm_cache") {
        return {
          select: () => ({
            eq: (_col: string, key: string) => ({
              maybeSingle: async () => ({
                data: cache.has(key) ? { response: cache.get(key) } : null,
                error: null,
              }),
            }),
          }),
          upsert: async (row: { cache_key: string; response: unknown }) => {
            cache.set(row.cache_key, row.response);
            return { error: null };
          },
        };
      }
      if (table === "usage_records") {
        return {
          insert: async (row: Record<string, unknown>) => {
            usage.push(row);
            return { error: null };
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  };
  const supabase = { getServiceClient: () => client } as unknown as SupabaseService;
  return { supabase, usage };
}

const statedLeaf = <T>(value: T, evidence: string): Evidenced<T> => ({
  value,
  status: "stated",
  confidence: 0.9,
  evidence,
});

const req = (
  id: string,
  text: string,
  category: RequirementCategory,
  importance: RequirementImportance = "must_have",
): JobRequirement => ({
  id,
  text: statedLeaf(text, text),
  category,
  importance,
});

const item = (id: string, text: string): MatchRequirementItem => ({
  id,
  text,
  category: "skill",
  importance: "must_have",
});

const verdictJson = (verdicts: unknown[]): string => JSON.stringify({ verdicts });

/** Jane Doe profile with languages replaced by EN/RU (no German). */
function enRuProfile(): CandidateProfile {
  const profile = fixtureProfile();
  profile.languages = [
    { language: statedLeaf("English", "English (fluent)"), level: statedLeaf("fluent", "English (fluent)") },
    { language: statedLeaf("Russian", "Russian (professional)"), level: statedLeaf("professional", "Russian (professional)") },
  ];
  return profile;
}

describe("match-requirements.v1 template (spec 003 §FR-7/§FR-10, T3.3)", () => {
  const profile = fixtureProfile();
  const template = createMatchRequirementsTemplate({
    profile,
    requirementIds: ["req-a"],
  });

  it("is versioned and on the strong model tier", () => {
    expect(template.templateVersion).toBe("match-requirements.v1");
    expect(template.modelTier).toBe("strong");
    expect(matchRequirementsSystemPrompt()).toContain("missing");
  });

  it("cacheInput is stable across requirement reordering and changes with content", () => {
    const projection = buildProfileProjection(profile);
    const t = createMatchRequirementsTemplate({ profile, requirementIds: ["req-a", "req-b"] });
    const a = t.cacheInput({ profile: projection, requirements: [item("req-a", "Docker"), item("req-b", "Kubernetes")] });
    const b = t.cacheInput({ profile: projection, requirements: [item("req-b", "Kubernetes"), item("req-a", "Docker")] });
    expect(a).toBe(b);
    const c = t.cacheInput({ profile: projection, requirements: [item("req-a", "Terraform"), item("req-b", "Kubernetes")] });
    expect(c).not.toBe(a);
  });

  it("validate accepts a schema-valid verdict set citing real paths", () => {
    const raw = {
      verdicts: [
        {
          requirement_id: "req-a",
          verdict: "match",
          confidence: 0.9,
          candidate_evidence: ["skills.frameworks[0]"],
          reasoning: "The profile lists NestJS at skills.frameworks[0].",
        },
      ],
    };
    expect(template.validate(raw)).not.toBeNull();
  });

  it("validate rejects verdicts citing non-existent profile paths", () => {
    const raw = {
      verdicts: [
        {
          requirement_id: "req-a",
          verdict: "match",
          confidence: 0.9,
          candidate_evidence: ["skills.cloud_platforms[9]"],
          reasoning: "Invented citation.",
        },
      ],
    };
    expect(template.validate(raw)).toBeNull();
  });

  it("validate enforces one verdict per input requirement id", () => {
    const verdict = {
      requirement_id: "req-a",
      verdict: "unknown",
      confidence: 0.8,
      candidate_evidence: [],
      reasoning: "Silent.",
    };
    // Missing id (empty) and duplicate id both fail.
    expect(template.validate({ verdicts: [] })).toBeNull();
    expect(template.validate({ verdicts: [verdict, verdict] })).toBeNull();
    // Extra unknown id fails too.
    expect(
      template.validate({ verdicts: [verdict, { ...verdict, requirement_id: "req-b" }] }),
    ).toBeNull();
  });

  it("validate enforces UNKNOWN-cites-nothing and MISSING-must-cite (spec §FR-7)", () => {
    expect(
      template.validate({
        verdicts: [
          {
            requirement_id: "req-a",
            verdict: "unknown",
            confidence: 0.8,
            candidate_evidence: ["skills.frameworks[0]"],
            reasoning: "Silence cannot cite.",
          },
        ],
      }),
    ).toBeNull();
    expect(
      template.validate({
        verdicts: [
          {
            requirement_id: "req-a",
            verdict: "missing",
            confidence: 0.8,
            candidate_evidence: [],
            reasoning: "A negative claim needs positive evidence.",
          },
        ],
      }),
    ).toBeNull();
  });
});

describe("buildProfileProjection (T3.3)", () => {
  it("ships only relevant sections, with stated array members carrying full-profile paths", () => {
    const projection = buildProfileProjection(fixtureProfile());
    const skills = projection.skills.map((s) => s.path);
    expect(skills).toContain("skills.programming_languages[0]");
    expect(skills).toContain("skills.frameworks[0]");
    // databases/cloud_platforms are empty in the fixture — nothing projected.
    expect(skills.some((p) => p.startsWith("skills.databases"))).toBe(false);
    // Scalars are always present — status reveals silence (remote_preference unknown).
    const remote = projection.location.find((f) => f.path === "location.remote_preference");
    expect(remote).toMatchObject({ status: "unknown", value: null });
    // Languages project language + level per entry.
    const languagePaths = projection.languages.map((f) => f.path);
    expect(languagePaths).toEqual([
      "languages[0].language",
      "languages[0].level",
      "languages[1].language",
      "languages[1].level",
    ]);
    // Roles are never shipped — the model cannot cite what it was not shown.
    expect(JSON.stringify(projection)).not.toContain("roles[");
  });
});

describe("matchRequirements (LLM verdict pass, T3.3)", () => {
  it("German required + languages [EN, RU] → missing via the LLM path (spec §FR-7)", async () => {
    const provider = makeProvider([
      verdictJson([
        {
          requirement_id: "req-de",
          verdict: "missing",
          confidence: 0.9,
          candidate_evidence: ["languages[0].language", "languages[1].language"],
          reasoning:
            "The profile positively lists English and Russian; the required German is not among them.",
        },
      ]),
    ]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile: enRuProfile(),
      unresolved: [req("req-de", "German language skills (B2 or higher)", "language")],
    });

    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({
      requirement_id: "req-de",
      verdict: "missing",
      candidate_evidence: ["languages[0].language", "languages[1].language"],
    });
    expect(result.meta.templateVersion).toBe(MATCH_REQUIREMENTS_TEMPLATE_VERSION);
    expect(usage[0]).toMatchObject({ operation: "match_requirements", cache_hit: false });
  });

  it("semantic equivalence: 'CI/CD pipelines' requirement vs GitHub Actions evidence → match with path citation", async () => {
    const profile = fixtureProfile();
    profile.skills.devops_tools.push({
      ...statedLeaf("GitHub Actions", "Built GitHub Actions pipelines for automated testing and deployment"),
    });
    const provider = makeProvider([
      verdictJson([
        {
          requirement_id: "req-cicd",
          verdict: "match",
          confidence: 0.85,
          candidate_evidence: ["skills.devops_tools[0]"],
          reasoning:
            "The profile evidences building GitHub Actions pipelines (skills.devops_tools[0]), which is CI/CD pipeline experience.",
        },
      ]),
    ]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile,
      unresolved: [req("req-cicd", "Experience with CI/CD pipelines", "skill")],
    });

    expect(result.verdicts[0]?.verdict).toBe("match");
    expect(result.verdicts[0]?.candidate_evidence).toEqual(["skills.devops_tools[0]"]);
  });

  it("a verdict citing a bogus path ('skills.cloud_platforms[9]') is rejected and repaired on retry", async () => {
    const bogus = verdictJson([
      {
        requirement_id: "req-k8s",
        verdict: "match",
        confidence: 0.9,
        candidate_evidence: ["skills.cloud_platforms[9]"],
        reasoning: "Hallucinated citation.",
      },
    ]);
    const fixed = verdictJson([
      {
        requirement_id: "req-k8s",
        verdict: "match",
        confidence: 0.9,
        candidate_evidence: ["skills.devops_tools[0]"],
        reasoning: "The profile lists Kubernetes at skills.devops_tools[0].",
      },
    ]);
    const profile = fixtureProfile();
    profile.skills.devops_tools.push(statedLeaf("Kubernetes", "Ran Kubernetes clusters"));
    const provider = makeProvider([bogus, fixed]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile,
      unresolved: [req("req-k8s", "Kubernetes", "skill")],
    });

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.verdicts[0]?.candidate_evidence).toEqual(["skills.devops_tools[0]"]);
  });

  it("persistently invalid output fails the call after the repair retry", async () => {
    const bogus = verdictJson([
      {
        requirement_id: "req-k8s",
        verdict: "match",
        confidence: 0.9,
        candidate_evidence: ["skills.cloud_platforms[9]"],
        reasoning: "Hallucinated citation.",
      },
    ]);
    const provider = makeProvider([bogus, bogus]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    await expect(
      matchRequirements(ai, {
        userId: "user-1",
        profile: fixtureProfile(),
        unresolved: [req("req-k8s", "Kubernetes", "skill")],
      }),
    ).rejects.toThrow(/unparseable/);
    expect(provider.complete).toHaveBeenCalledTimes(2);
  });

  it("one verdict per input requirement id is enforced across the retry", async () => {
    const incomplete = verdictJson([
      {
        requirement_id: "req-a",
        verdict: "unknown",
        confidence: 0.8,
        candidate_evidence: [],
        reasoning: "Silent.",
      },
    ]);
    const complete = verdictJson([
      {
        requirement_id: "req-a",
        verdict: "unknown",
        confidence: 0.8,
        candidate_evidence: [],
        reasoning: "Silent.",
      },
      {
        requirement_id: "req-b",
        verdict: "unknown",
        confidence: 0.8,
        candidate_evidence: [],
        reasoning: "Silent.",
      },
    ]);
    const provider = makeProvider([incomplete, complete]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile: fixtureProfile(),
      unresolved: [req("req-a", "Rust", "skill"), req("req-b", "GraphQL", "skill")],
    });

    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.verdicts.map((v) => v.requirement_id)).toEqual(["req-a", "req-b"]);
  });

  it("identical inputs are served from cache (second call costs zero provider calls)", async () => {
    const provider = makeProvider([
      verdictJson([
        {
          requirement_id: "req-a",
          verdict: "unknown",
          confidence: 0.8,
          candidate_evidence: [],
          reasoning: "Silent.",
        },
      ]),
    ]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);
    const opts = {
      userId: "user-1",
      profile: fixtureProfile(),
      unresolved: [req("req-a", "Rust", "skill")],
    };

    const first = await matchRequirements(ai, opts);
    // Reordered requirement list + fresh array: same cache identity.
    const second = await matchRequirements(ai, { ...opts, unresolved: [...opts.unresolved] });

    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(first.meta.cacheHit).toBe(false);
    expect(second.meta.cacheHit).toBe(true);
    expect(second.verdicts).toEqual(first.verdicts);
    expect(usage[1]).toMatchObject({ operation: "match_requirements", cache_hit: true });
  });

  it("no unresolved requirements → no LLM call, zero usage", async () => {
    const provider = makeProvider([]);
    const { supabase, usage } = makeSupabase();
    const ai = new AiService(supabase, provider);

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile: fixtureProfile(),
      unresolved: [],
    });

    expect(result.verdicts).toEqual([]);
    expect(result.meta.skipped).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
    expect(usage).toEqual([]);
  });

  it("requirements with unstated text get a deterministic unknown verdict without an LLM call", async () => {
    const provider = makeProvider([]);
    const { supabase } = makeSupabase();
    const ai = new AiService(supabase, provider);
    const unstated: JobRequirement = {
      id: "req-x",
      text: { value: null, status: "unknown", confidence: 0, evidence: null },
      category: "other",
      importance: "nice_to_have",
    };

    const result = await matchRequirements(ai, {
      userId: "user-1",
      profile: fixtureProfile(),
      unresolved: [unstated],
    });

    expect(result.verdicts[0]?.verdict).toBe("unknown");
    expect(result.meta.skipped).toBe(true);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});
