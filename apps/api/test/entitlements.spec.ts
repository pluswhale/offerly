import { describe, expect, it } from "vitest";
import { EntitlementsService } from "../src/modules/entitlements/entitlements.service.js";
import { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { FakeSupabaseClient, type Terminal } from "./helpers/fake-supabase.js";

const USER = "user-1";
const TOKEN = "token";

function makeService(queues: Record<string, Terminal[]>): {
  service: EntitlementsService;
  client: FakeSupabaseClient;
} {
  const client = new FakeSupabaseClient();
  for (const [table, terminals] of Object.entries(queues)) client.queue(table, terminals);
  const supabase = { forUser: () => client } as unknown as SupabaseService;
  return { service: new EntitlementsService(supabase), client };
}

const FREE = { data: { plan: "free", status: "active" } };
const PRO = { data: { plan: "pro", status: "active" } };

describe("EntitlementsService.getPlan", () => {
  it("defaults to free when no subscription row", async () => {
    const { service } = makeService({ subscriptions: [{ data: null }] });
    expect(await service.getPlan(USER, TOKEN)).toBe("free");
  });
  it("pro only when active/trialing", async () => {
    const { service } = makeService({ subscriptions: [PRO] });
    expect(await service.getPlan(USER, TOKEN)).toBe("pro");
    const canceled = makeService({
      subscriptions: [{ data: { plan: "pro", status: "canceled" } }],
    });
    expect(await canceled.service.getPlan(USER, TOKEN)).toBe("free");
  });
});

describe("EntitlementsService decision matrix (T10.2)", () => {
  it("cv_create: free blocked at the 1-CV limit unless replacing; pro unlimited", async () => {
    const atLimit = makeService({ subscriptions: [FREE], cvs: [{ count: 1 }] });
    expect(
      await atLimit.service.checkAccess(USER, TOKEN, "cv_create", { body: {} }),
    ).toMatchObject({ feature: "cv_create" });

    // Replace flow keeps the stored count unchanged — allowed at the limit.
    const replacing = makeService({ subscriptions: [FREE], cvs: [{ count: 1 }] });
    expect(
      await replacing.service.checkAccess(USER, TOKEN, "cv_create", {
        body: { replace_cv_id: "cv-1" },
      }),
    ).toBeNull();

    const first = makeService({ subscriptions: [FREE], cvs: [{ count: 0 }] });
    expect(await first.service.checkAccess(USER, TOKEN, "cv_create", { body: {} })).toBeNull();

    const pro = makeService({ subscriptions: [PRO], cvs: [{ count: 50 }] });
    expect(await pro.service.checkAccess(USER, TOKEN, "cv_create", { body: {} })).toBeNull();
  });

  it("coach: free → denied, pro → allowed", async () => {
    const free = makeService({ subscriptions: [FREE] });
    expect(await free.service.checkAccess(USER, TOKEN, "coach")).toMatchObject({
      feature: "coach",
    });
    const pro = makeService({ subscriptions: [PRO] });
    expect(await pro.service.checkAccess(USER, TOKEN, "coach")).toBeNull();
  });

  it("apply_generate: free gets one sample, then denied; pro unlimited", async () => {
    const first = makeService({ subscriptions: [FREE], usage_records: [{ count: 0 }] });
    expect(await first.service.checkAccess(USER, TOKEN, "apply_generate")).toBeNull();

    const used = makeService({ subscriptions: [FREE], usage_records: [{ count: 1 }] });
    expect(await used.service.checkAccess(USER, TOKEN, "apply_generate")).toMatchObject({
      feature: "apply_generate",
    });

    const pro = makeService({ subscriptions: [PRO], usage_records: [{ count: 50 }] });
    expect(await pro.service.checkAccess(USER, TOKEN, "apply_generate")).toBeNull();
  });

  it("application_create: free blocked at 10 non-archived, pro unlimited", async () => {
    const nine = makeService({ subscriptions: [FREE], applications: [{ count: 9 }] });
    expect(await nine.service.checkAccess(USER, TOKEN, "application_create")).toBeNull();

    const ten = makeService({ subscriptions: [FREE], applications: [{ count: 10 }] });
    expect(await ten.service.checkAccess(USER, TOKEN, "application_create")).toMatchObject({
      feature: "application_create",
    });

    const pro = makeService({ subscriptions: [PRO], applications: [{ count: 500 }] });
    expect(await pro.service.checkAccess(USER, TOKEN, "application_create")).toBeNull();
  });

  it("application_modify: over-limit is read-only but archiving stays allowed", async () => {
    const archive = makeService({ subscriptions: [FREE] });
    expect(
      await archive.service.checkAccess(USER, TOKEN, "application_modify", {
        body: { archived: true },
      }),
    ).toBeNull();

    const overLimit = makeService({ subscriptions: [FREE], applications: [{ count: 12 }] });
    expect(
      await overLimit.service.checkAccess(USER, TOKEN, "application_modify", { body: {} }),
    ).toMatchObject({ feature: "application_modify" });

    const underLimit = makeService({ subscriptions: [FREE], applications: [{ count: 3 }] });
    expect(
      await underLimit.service.checkAccess(USER, TOKEN, "application_modify", { body: {} }),
    ).toBeNull();
  });

  it("cv_analysis: repeat analysis of same CV is free; first analysis consumes the 1-analysis limit", async () => {
    const repeat = makeService({
      subscriptions: [FREE],
      cv_analyses: [{ count: 1 }], // existing analysis for this cv
    });
    expect(
      await repeat.service.checkAccess(USER, TOKEN, "cv_analysis", { cvId: "cv-1" }),
    ).toBeNull();

    const secondCv = makeService({
      subscriptions: [FREE],
      cv_analyses: [{ count: 0 }, { count: 1 }], // none for this cv, 1 total → limit hit
    });
    expect(
      await secondCv.service.checkAccess(USER, TOKEN, "cv_analysis", { cvId: "cv-2" }),
    ).toMatchObject({ feature: "cv_analysis" });
  });

  it("cv_analysis: monthly AI quota (5) blocks even the first analysis", async () => {
    const atQuota = makeService({
      subscriptions: [FREE],
      cv_analyses: [{ count: 0 }, { count: 0 }],
      usage_records: [{ count: 5 }],
    });
    expect(
      await atQuota.service.checkAccess(USER, TOKEN, "cv_analysis", { cvId: "cv-1" }),
    ).toMatchObject({ feature: "cv_analysis" });

    const belowQuota = makeService({
      subscriptions: [FREE],
      cv_analyses: [{ count: 0 }, { count: 0 }],
      usage_records: [{ count: 4 }],
    });
    expect(
      await belowQuota.service.checkAccess(USER, TOKEN, "cv_analysis", { cvId: "cv-1" }),
    ).toBeNull();
  });

  it("job_match: existing match is free; new match consumes monthly quota; pro passes", async () => {
    const cached = makeService({
      subscriptions: [FREE],
      cvs: [{ data: { id: "cv-1" } }],
      job_matches: [{ count: 1 }],
    });
    expect(
      await cached.service.checkAccess(USER, TOKEN, "job_match", { jobId: "job-1" }),
    ).toBeNull();

    const atQuota = makeService({
      subscriptions: [FREE],
      cvs: [{ data: { id: "cv-1" } }],
      job_matches: [{ count: 0 }],
      usage_records: [{ count: 5 }],
    });
    expect(
      await atQuota.service.checkAccess(USER, TOKEN, "job_match", { jobId: "job-1" }),
    ).toMatchObject({ feature: "job_match" });

    const pro = makeService({
      subscriptions: [PRO],
      cvs: [{ data: { id: "cv-1" } }],
      job_matches: [{ count: 0 }],
      usage_records: [{ count: 999 }],
    });
    expect(
      await pro.service.checkAccess(USER, TOKEN, "job_match", { jobId: "job-1" }),
    ).toBeNull();
  });
});
