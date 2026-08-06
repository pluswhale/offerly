import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateProfile } from "@offerly/types";
import type { AiService } from "../src/modules/ai/ai.service.js";
import type { ChatMessage } from "../src/modules/ai/llm-provider.js";
import {
  buildCoachProfileProjection,
  buildCoachSystemPrompt,
  COACH_CONTEXT_TOKEN_BUDGET,
  collectChallengeEvidence,
  isEvidenceChallenge,
  templateVersion,
  type CoachManifest,
} from "../src/modules/ai/prompts/coach.v2.js";
import { estimateTokens } from "../src/modules/ai/text.js";
import { CoachService, type CoachStreamEvent } from "../src/modules/coach/coach.service.js";
import type { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { fixtureProfile } from "./fixtures/cv-profile.fixture.js";
import { FakeSupabaseClient } from "./helpers/fake-supabase.js";

const USER = "user-1";
const TOKEN = "token";
const CONV_ID = "33333333-3333-3333-3333-333333333333";
const JOB_ID = "22222222-2222-2222-2222-222222222222";

const RAW_CV_TEXT = "RAW CV SECRET SENTENCE that must never reach the coach";

function baseManifest(overrides: Partial<CoachManifest> = {}): CoachManifest {
  return {
    fullName: "Jane Doe",
    currentRole: "Backend Developer",
    targetRole: "Senior Backend Engineer",
    goals: null,
    profile: null,
    matches: [],
    pipeline: { applied: 2 },
    staleApplications: 0,
    lastAdvice: null,
    evidence: [],
    ...overrides,
  };
}

describe("coach.v2 prompt (spec 003 §FR-11, T4.3)", () => {
  it("projection carries values + statuses, never evidence quotes", () => {
    const projection = buildCoachProfileProjection(fixtureProfile());
    const rendered = JSON.stringify(projection);
    expect(rendered).toContain("TypeScript");
    expect(rendered).toContain("headline.title: Senior Backend Engineer (stated)");
    // Evidence quotes stay out of the manifest — drill-down only.
    expect(rendered).not.toContain("Built services in TypeScript and NestJS");
    // Unknown scalars are explicit, matching the matching-projection semantics.
    const sparse = fixtureProfile();
    sparse.summary_quality = 78;
    sparse.headline.seniority = { value: null, status: "unknown", confidence: 0, evidence: null };
    const sparseProjection = buildCoachProfileProjection(sparse);
    expect(JSON.stringify(sparseProjection)).toContain("headline.seniority: unknown (unknown)");
    expect(sparseProjection.summaryQuality).toBe(78);
  });

  it("system prompt keeps the v1 persona/honesty rules and grounds answers in the manifest", () => {
    const prompt = buildCoachSystemPrompt(baseManifest());
    expect(templateVersion).toBe("coach.v2");
    expect(prompt).toContain("Never claim the user has experience they have not stated");
    expect(prompt).toContain("untrusted user-provided data");
    expect(prompt).toContain("you do not have the raw CV text");
    expect(prompt).toContain("politely redirect");
    expect(prompt).toContain("<coach_context>");
  });

  it("no ready profile → explicit build-the-profile note", () => {
    const prompt = buildCoachSystemPrompt(baseManifest({ profile: null }));
    expect(prompt).toContain("No candidate profile yet");
    expect(prompt).toContain("Suggest uploading a CV and building the profile");
  });

  it("match summaries include score + must-have gaps", () => {
    const prompt = buildCoachSystemPrompt(
      baseManifest({
        matches: [
          {
            jobTitle: "Senior Backend Engineer",
            company: "Acme",
            score: 68,
            lowConfidence: false,
            gaps: ["Docker experience (missing)", "Kubernetes (partial)"],
          },
        ],
      }),
    );
    expect(prompt).toContain("Senior Backend Engineer @ Acme: score 68");
    expect(prompt).toContain("gaps: Docker experience (missing), Kubernetes (partial)");
  });

  it("budgeter trims matches first, then profile arrays — identity and goals survive", () => {
    const fat = "x".repeat(150);
    const projection = buildCoachProfileProjection(fixtureProfile());
    projection.skills = Array.from({ length: 7 }, (_, i) => ({
      path: `skills.group_${i}`,
      values: Array.from({ length: 10 }, (_, j) => `${fat}-${j}`),
    }));
    const prompt = buildCoachSystemPrompt(
      baseManifest({
        goals: { target_location: "Berlin", target_salary: null, priority: "remote-first" },
        profile: projection,
        matches: Array.from({ length: 5 }, (_, i) => ({
          jobTitle: `Job ${i} ${fat}`,
          company: "Acme",
          score: 90 - i,
          lowConfidence: false,
          gaps: Array.from({ length: 3 }, (_, j) => `${fat}-gap-${j}`),
        })),
        lastAdvice: fat.repeat(4),
      }),
    );
    expect(estimateTokens(prompt)).toBeLessThanOrEqual(COACH_CONTEXT_TOKEN_BUDGET);
    // Identity and goals are never trimmed.
    expect(prompt).toContain("Name: Jane Doe");
    expect(prompt).toContain("target location: Berlin");
    expect(prompt).toContain("priority: remote-first");
  });

  it("evidence drill-down: heuristic + quote collection for mentioned facts only", () => {
    const profile = fixtureProfile();
    expect(isEvidenceChallenge("Why do you think I know TypeScript?")).toBe(true);
    expect(isEvidenceChallenge("What should I improve in my CV?")).toBe(false);

    const quotes = collectChallengeEvidence(profile, "Why do you think I know TypeScript?");
    const paths = quotes.map((q) => q.path);
    expect(paths).toContain("skills.programming_languages[0]");
    const quote = quotes.find((q) => q.path === "skills.programming_languages[0]");
    expect(quote?.quote).toBe("Built services in TypeScript and NestJS");
    // Facts the user did not mention stay out.
    expect(paths).not.toContain("skills.frameworks[0]");
    // A non-challenge message collects nothing at the call site (service guards
    // with isEvidenceChallenge), and an unrelated mention matches no values.
    expect(collectChallengeEvidence(profile, "tell me about databases")).toEqual([]);
  });
});

/**
 * Service-level tests: CoachService over the terminal-queue FakeSupabaseClient
 * (same helper as cvs/billing specs) with a stubbed AiService capturing the
 * provider messages. v2 must never fetch/inject raw CV text.
 */
function makeService(opts: {
  profile?: CandidateProfile | null;
  matchReport?: boolean;
  history?: unknown[];
  staleDays?: number;
}) {
  const staleDate = new Date(Date.now() - (opts.staleDays ?? 20) * 24 * 60 * 60 * 1000).toISOString();
  const db = new FakeSupabaseClient({
    ai_conversations: {
      data: { id: CONV_ID, user_id: USER, kind: "coach", context: {}, created_at: staleDate },
    },
    profiles: {
      data: {
        full_name: "Jane Doe",
        current_role: "Backend Developer",
        target_role: "Senior Backend Engineer",
        user_goals: { target_location: "Berlin", target_salary: null, priority: null },
      },
    },
    candidate_profiles: {
      data: opts.profile ? { profile: opts.profile } : null,
    },
    job_matches: {
      data: opts.matchReport
        ? [
            {
              job_id: JOB_ID,
              score: 68,
              result: {
                version: 2,
                score: 68,
                low_confidence: false,
                verdicts: [
                  {
                    requirement_id: "req-1",
                    verdict: "missing",
                    confidence: 0.9,
                    candidate_evidence: [],
                    reasoning: "No Docker mention.",
                  },
                  {
                    requirement_id: "req-2",
                    verdict: "match",
                    confidence: 0.95,
                    candidate_evidence: ["skills.programming_languages[0]"],
                    reasoning: "TypeScript stated.",
                  },
                ],
              },
            },
          ]
        : [],
    },
    jobs: { data: [{ id: JOB_ID, title: "Senior Backend Engineer", company: "Acme" }] },
    job_profiles: {
      data: [
        {
          job_id: JOB_ID,
          profile: {
            requirements: [
              {
                id: "req-1",
                text: { value: "Docker experience", status: "stated", confidence: 0.9, evidence: "Docker" },
                category: "skill",
                importance: "must_have",
              },
              {
                id: "req-2",
                text: { value: "TypeScript", status: "stated", confidence: 0.9, evidence: "TypeScript" },
                category: "skill",
                importance: "must_have",
              },
            ],
          },
        },
      ],
    },
    applications: { data: [{ status: "applied", updated_at: staleDate }] },
    ai_messages: {
      data: opts.history ?? [
        {
          id: "m1",
          conversation_id: CONV_ID,
          role: "assistant",
          content: "Previous advice: tailor your CV to Acme.",
          token_count: 10,
          created_at: staleDate,
        },
      ],
    },
    // Present to prove v2 never injects it (and to feed the v1 rollback test).
    cvs: { data: { extracted_text: RAW_CV_TEXT } },
  });

  const captured: ChatMessage[][] = [];
  const ai = {
    streamText: vi.fn((o: { messages: ChatMessage[] }) => {
      captured.push(o.messages);
      return (async function* () {
        yield "coach reply";
      })();
    }),
    completeText: vi.fn(async () => "summary"),
  } as unknown as AiService;

  const supabase = { forUser: () => db } as unknown as SupabaseService;
  const service = new CoachService(supabase, ai);
  return { service, db, captured };
}

async function drain(events: AsyncIterable<CoachStreamEvent>): Promise<CoachStreamEvent[]> {
  const out: CoachStreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe("CoachService v2 manifest (T4.3)", () => {
  afterEach(() => {
    delete process.env.COACH_TEMPLATE_VERSION;
  });

  it("streams a reply whose system context has profile facts but NO raw CV text (AC-5)", async () => {
    const { service, captured, db } = makeService({ profile: fixtureProfile(), matchReport: true });
    const { events } = await service.prepareMessage(USER, TOKEN, CONV_ID, "How am I doing?");
    const stream = await drain(events);

    expect(stream.map((e) => e.type)).toEqual(["token", "done"]);
    const system = captured[0]?.[0];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("TypeScript");
    expect(system?.content).toContain("Senior Backend Engineer");
    expect(system?.content).not.toContain(RAW_CV_TEXT);
    // No evidence quotes without a challenge.
    expect(system?.content).not.toContain("Built services in TypeScript and NestJS");
    // The cvs table is not queried at all on the v2 path.
    expect(db.fromCalls).not.toContain("cvs");
    // Assistant reply is persisted as before.
    expect(
      db.calls.some(
        (c) =>
          c.table === "ai_messages" &&
          c.method === "insert" &&
          (c.payload as { role?: string }).role === "assistant",
      ),
    ).toBe(true);
  });

  it("system context estimate stays within the 2.5k token budget on the fixture account", async () => {
    const { service, captured } = makeService({ profile: fixtureProfile(), matchReport: true });
    const { events } = await service.prepareMessage(USER, TOKEN, CONV_ID, "How am I doing?");
    await drain(events);
    const system = captured[0]?.[0]?.content ?? "";
    expect(estimateTokens(system)).toBeLessThanOrEqual(COACH_CONTEXT_TOKEN_BUDGET);
  });

  it("match report present → gap summary + goals + stale count in context", async () => {
    const { service, captured } = makeService({ profile: fixtureProfile(), matchReport: true });
    const { events } = await service.prepareMessage(
      USER,
      TOKEN,
      CONV_ID,
      "What should I improve for the Acme job?",
    );
    await drain(events);
    const system = captured[0]?.[0]?.content ?? "";
    expect(system).toContain("Senior Backend Engineer @ Acme: score 68");
    expect(system).toContain("Docker experience (missing)");
    expect(system).toContain("target location: Berlin");
    expect(system).toContain("no progress in 14+ days");
    expect(system).toContain("Previous advice: tailor your CV to Acme.");
  });

  it("no ready profile → build-the-profile note instead of projection", async () => {
    const { service, captured } = makeService({ profile: null, matchReport: false });
    const { events } = await service.prepareMessage(USER, TOKEN, CONV_ID, "Hi");
    await drain(events);
    const system = captured[0]?.[0]?.content ?? "";
    expect(system).toContain("No candidate profile yet");
  });

  it("evidence drill-down: a 'why do you think' challenge adds the fact's quote", async () => {
    const { service, captured } = makeService({ profile: fixtureProfile(), matchReport: false });
    const { events } = await service.prepareMessage(
      USER,
      TOKEN,
      CONV_ID,
      "Why do you think I know TypeScript?",
    );
    await drain(events);
    const system = captured[0]?.[0]?.content ?? "";
    expect(system).toContain("Evidence quotes from the user's CV");
    expect(system).toContain('skills.programming_languages[0] = "TypeScript"');
    expect(system).toContain("Built services in TypeScript and NestJS");
  });

  it("COACH_TEMPLATE_VERSION=v1 rolls back to the raw-CV prompt without a deploy", async () => {
    process.env.COACH_TEMPLATE_VERSION = "v1";
    const { service, captured } = makeService({ profile: fixtureProfile(), matchReport: true });
    const { events } = await service.prepareMessage(USER, TOKEN, CONV_ID, "Hi");
    await drain(events);
    const system = captured[0]?.[0]?.content ?? "";
    // v1 behavior: truncated raw CV text is injected.
    expect(system).toContain(RAW_CV_TEXT);
    expect(system).not.toContain("<coach_context>");
  });
});
