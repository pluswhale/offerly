import { describe, expect, it } from "vitest";
import type { Application, Cv } from "@offerly/types";
import { nextBestAction } from "./next-action";

const DAY_MS = 24 * 60 * 60 * 1000;

const cv: Cv = {
  id: "cv-1",
  user_id: "user-1",
  name: "CV",
  file_path: null,
  extracted_text: null,
  content_hash: null,
  is_active: true,
  created_at: new Date().toISOString(),
};

function applied(changedDaysAgo: number): Application {
  const changed = new Date(Date.now() - changedDaysAgo * DAY_MS).toISOString();
  return {
    id: `app-${changedDaysAgo}`,
    user_id: "user-1",
    job_id: null,
    company: "Acme",
    role: "Engineer",
    status: "applied",
    applied_at: null,
    notes: null,
    archived: false,
    status_changed_at: changed,
    created_at: changed,
    updated_at: changed,
  };
}

describe("nextBestAction follow-up", () => {
  it("does not suggest a follow-up for an application 10 days in stage", () => {
    const action = nextBestAction({ cvs: [cv], applications: [applied(10)] });
    expect(action.title).not.toMatch(/Follow up/);
  });

  it("suggests a follow-up for an application 15 days in stage", () => {
    const action = nextBestAction({ cvs: [cv], applications: [applied(15), applied(10)] });
    expect(action.title).toBe("Follow up on 1 application");
  });
});
