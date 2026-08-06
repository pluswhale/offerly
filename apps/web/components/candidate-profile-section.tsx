"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ProfileSkills, RunCandidateProfileResponse } from "@offerly/types";
import { api, ApiError, PaywallError } from "@/lib/api";
import type {
  CandidateProfileWithData,
  ProfilePipelineStage,
  UpgradeRequiredPayload,
} from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { PaywallModal } from "@/components/paywall-modal";
import { ProfileField } from "@/components/profile-field";
import { ScoreRing } from "@/components/score-ring";
import { Skeleton } from "@/components/skeleton";

/**
 * Candidate Profile section (spec 003 §FR-2/§FR-3/§FR-4, T2.7) on the CV
 * detail page: completeness header, grouped Evidenced fields with badges +
 * expandable evidence, inline corrections via PATCH, and live pipeline
 * progress (POST → poll GET every 2s until ready|failed).
 */

const POLL_MS = 2000;

type LoadState =
  | { kind: "loading" }
  | { kind: "none" } // 404 — no profile built yet
  | { kind: "error"; message: string }
  | { kind: "data"; row: CandidateProfileWithData };

const SENIORITY_OPTIONS = [
  "junior",
  "mid",
  "senior",
  "staff",
  "lead",
  "manager",
  "executive",
] as const;

const LANGUAGE_LEVEL_OPTIONS = ["native", "fluent", "professional", "basic"] as const;

const REMOTE_PREFERENCE_OPTIONS = ["onsite", "hybrid", "remote", "any"] as const;

const SKILL_GROUPS: ReadonlyArray<{ key: keyof ProfileSkills; label: string }> = [
  { key: "programming_languages", label: "Programming languages" },
  { key: "frameworks", label: "Frameworks" },
  { key: "cloud_platforms", label: "Cloud" },
  { key: "databases", label: "Databases" },
  { key: "devops_tools", label: "DevOps" },
  { key: "other_technologies", label: "Other technologies" },
  { key: "soft_skills", label: "Soft skills" },
];

const FAILED_STAGE_LABEL: Record<ProfilePipelineStage, string> = {
  extracting: "extracting facts from your CV",
  validating: "validating the extracted facts",
  persist: "saving the profile",
};

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-neutral-500 uppercase">
        {title}
      </h3>
      <div className="mt-1 divide-y divide-neutral-100">{children}</div>
    </div>
  );
}

/** Extracting → Validating → Done stepper shown while the pipeline runs. */
function StageIndicator({ status }: { status: "extracting" | "validating" }) {
  const steps = ["Extracting facts", "Validating evidence", "Done"];
  const activeIndex = status === "extracting" ? 0 : 1;
  return (
    <ol className="flex flex-col gap-3" aria-label="Pipeline progress">
      {steps.map((label, i) => {
        const state = i < activeIndex ? "done" : i === activeIndex ? "active" : "pending";
        return (
          <li key={label} className="flex items-center gap-3" aria-current={state === "active" ? "step" : undefined}>
            {state === "active" ? (
              <span
                aria-hidden="true"
                className="size-5 shrink-0 animate-spin rounded-full border-2 border-accent-600 border-t-transparent"
              />
            ) : (
              <span
                aria-hidden="true"
                className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                  state === "done"
                    ? "bg-accent-600 text-white"
                    : "border border-neutral-300 text-neutral-400"
                }`}
              >
                {state === "done" ? "✓" : i + 1}
              </span>
            )}
            <span
              className={`text-sm ${
                state === "active"
                  ? "font-medium text-neutral-900"
                  : state === "done"
                    ? "text-neutral-600"
                    : "text-neutral-400"
              }`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function CandidateProfileSection({ cvId }: { cvId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [building, setBuilding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  const load = useCallback(async () => {
    try {
      const row = await api<CandidateProfileWithData>(`/cvs/${cvId}/profile`);
      setState({ kind: "data", row });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setState({ kind: "none" });
      } else {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Couldn't load the profile",
        });
      }
    }
  }, [cvId]);

  useEffect(() => {
    // Defer like useApi does: synchronous setState in an effect body causes
    // cascading renders (react-hooks/set-state-in-effect).
    queueMicrotask(() => void load());
  }, [load]);

  // Poll while the pipeline runs (spec §FR-3: POST returns 202, GET reports progress).
  const status = state.kind === "data" ? state.row.status : null;
  useEffect(() => {
    if (status !== "extracting" && status !== "validating") return;
    const timer = setTimeout(() => void load(), POLL_MS);
    return () => clearTimeout(timer);
  }, [status, load]);

  async function build() {
    setBuilding(true);
    setActionError(null);
    try {
      const res = await api<RunCandidateProfileResponse | CandidateProfileWithData>(
        `/cvs/${cvId}/profile`,
        { method: "POST" },
      );
      if ("profile_id" in res) {
        // 202 — pipeline running; fetch the fresh row, polling takes over.
        await load();
      } else {
        // 200 — idempotent hit, an up-to-date ready profile already exists.
        setState({ kind: "data", row: res });
      }
    } catch (err) {
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setActionError(err instanceof Error ? err.message : "Couldn't start the profile build");
    } finally {
      setBuilding(false);
    }
  }

  const patch = useCallback(
    async (path: string, value: unknown) => {
      const row = await api<CandidateProfileWithData>(`/cvs/${cvId}/profile`, {
        method: "PATCH",
        json: { path, value },
      });
      setState({ kind: "data", row });
    },
    [cvId],
  );

  if (state.kind === "none") {
    return (
      <section aria-label="Candidate Profile" className="flex flex-col gap-3">
        <h2 className="text-base font-semibold text-neutral-900">Candidate Profile</h2>
        {actionError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        )}
        <EmptyState
          title="No candidate profile yet"
          description="Build an evidence-linked profile from this CV — every fact the AI extracts stays tied to the sentence it came from, and you can correct anything it gets wrong."
          action={
            <Button onClick={() => void build()} loading={building}>
              Build profile
            </Button>
          }
        />
        <PaywallModal
          open={paywall !== null}
          onClose={() => setPaywall(null)}
          payload={paywall}
          attempted="Building a candidate profile"
        />
      </section>
    );
  }

  const row = state.kind === "data" ? state.row : null;

  return (
    <section aria-label="Candidate Profile">
      <Card>
        <CardHeader
          title="Candidate Profile"
          description="What the AI understood from this CV — every fact linked to its source sentence."
          action={
            row && (row.status === "ready" || row.status === "failed") ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void build()}
                loading={building}
              >
                {row.status === "failed" ? "Retry" : "Rebuild"}
              </Button>
            ) : undefined
          }
        />
        <CardBody className="flex flex-col gap-6">
          {actionError && (
            <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {actionError}
            </p>
          )}

          {state.kind === "loading" && (
            <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading profile">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-full" />
              <Skeleton className="h-5 w-2/3" />
            </div>
          )}

          {state.kind === "error" && (
            <div className="flex flex-col items-start gap-3">
              <p role="alert" className="text-sm text-red-700">
                {state.message}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                Try again
              </Button>
            </div>
          )}

          {row && (row.status === "extracting" || row.status === "validating") && (
            <div aria-live="polite">
              <StageIndicator status={row.status} />
              <p className="mt-3 text-sm text-neutral-500">
                Building your profile — this usually takes under a minute.
              </p>
            </div>
          )}

          {row?.status === "failed" && (
            <div className="flex flex-col items-start gap-3 rounded-lg bg-red-50 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-red-800">
                  The profile build failed
                  {row.stage_meta?.failed_stage
                    ? ` while ${FAILED_STAGE_LABEL[row.stage_meta.failed_stage]}`
                    : ""}
                  .
                </p>
                {row.stage_meta?.failure_reason && (
                  <p className="mt-1 text-sm text-red-700">{row.stage_meta.failure_reason}</p>
                )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => void build()} loading={building}>
                Retry
              </Button>
            </div>
          )}

          {row?.status === "ready" && (
            <ReadyProfile row={row} patch={patch} />
          )}
        </CardBody>
      </Card>
      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Building a candidate profile"
      />
    </section>
  );
}

function ReadyProfile({
  row,
  patch,
}: {
  row: CandidateProfileWithData;
  patch: (path: string, value: unknown) => Promise<void>;
}) {
  const profile = row.profile;
  const hasSkills = SKILL_GROUPS.some((g) => profile.skills[g.key].length > 0);

  return (
    <>
      {/* Completeness header (spec §FR-2: summary_quality, derived in S4) */}
      <div className="flex items-center gap-4">
        <ScoreRing score={profile.summary_quality ?? 0} size={72} label="complete" />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-neutral-900">Profile completeness</p>
          <p className="mt-0.5 text-xs text-neutral-500">
            Share of profile facts grounded in this CV. Edit any field to complete
            it — your corrections survive rebuilds.
          </p>
        </div>
      </div>

      <Group title="Headline">
        <ProfileField label="Title" leaf={profile.headline.title} path="headline.title" editor={{ kind: "text" }} onPatch={patch} />
        <ProfileField label="Seniority" leaf={profile.headline.seniority} path="headline.seniority" editor={{ kind: "select", options: SENIORITY_OPTIONS }} onPatch={patch} />
        <ProfileField label="Years of experience" leaf={profile.headline.total_years_experience} path="headline.total_years_experience" editor={{ kind: "number" }} onPatch={patch} />
      </Group>

      {profile.roles.length > 0 && (
        <Group title="Roles">
          {profile.roles.map((role, i) => (
            <div key={`roles[${i}]`} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-neutral-900">
                  {role.title.value ?? "Untitled role"}
                  {role.company.value ? ` · ${role.company.value}` : ""}
                </p>
                {role.is_current && <Badge tone="accent">Current</Badge>}
              </div>
              <div className="mt-1 divide-y divide-neutral-100">
                <ProfileField label="Title" leaf={role.title} path={`roles[${i}].title`} editor={{ kind: "text" }} onPatch={patch} />
                <ProfileField label="Company" leaf={role.company} path={`roles[${i}].company`} editor={{ kind: "text" }} onPatch={patch} />
                <ProfileField label="Start" leaf={role.start} path={`roles[${i}].start`} editor={{ kind: "text" }} onPatch={patch} />
                <ProfileField label="End" leaf={role.end} path={`roles[${i}].end`} editor={{ kind: "text" }} onPatch={patch} />
                <ProfileField label="Industry" leaf={role.industry} path={`roles[${i}].industry`} editor={{ kind: "text" }} onPatch={patch} />
                <ProfileField label="Scope" leaf={role.scope} path={`roles[${i}].scope`} editor={{ kind: "text" }} onPatch={patch} />
              </div>
            </div>
          ))}
        </Group>
      )}

      {hasSkills && (
        <Group title="Skills">
          {SKILL_GROUPS.filter((g) => profile.skills[g.key].length > 0).map((g) => (
            <div key={g.key} className="py-2">
              <p className="text-sm font-medium text-neutral-700">{g.label}</p>
              <div className="mt-1 flex flex-wrap gap-2">
                {profile.skills[g.key].map((skill, i) => (
                  <div
                    key={`skills.${g.key}[${i}]`}
                    className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3"
                  >
                    <ProfileField
                      leaf={skill}
                      path={`skills.${g.key}[${i}]`}
                      editor={{ kind: "text" }}
                      onPatch={patch}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </Group>
      )}

      <Group title="Experience">
        {profile.experience.industries.length > 0 && (
          <div className="py-2">
            <p className="text-sm font-medium text-neutral-700">Industries</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {profile.experience.industries.map((item, i) => (
                <div key={`experience.industries[${i}]`} className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3">
                  <ProfileField leaf={item} path={`experience.industries[${i}]`} editor={{ kind: "text" }} onPatch={patch} />
                </div>
              ))}
            </div>
          </div>
        )}
        {profile.experience.domains.length > 0 && (
          <div className="py-2">
            <p className="text-sm font-medium text-neutral-700">Domains</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {profile.experience.domains.map((item, i) => (
                <div key={`experience.domains[${i}]`} className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3">
                  <ProfileField leaf={item} path={`experience.domains[${i}]`} editor={{ kind: "text" }} onPatch={patch} />
                </div>
              ))}
            </div>
          </div>
        )}
        <ProfileField label="Team size managed" leaf={profile.experience.team_sizes_managed} path="experience.team_sizes_managed" editor={{ kind: "number" }} onPatch={patch} />
        <ProfileField label="Leadership" leaf={profile.experience.leadership} path="experience.leadership" editor={{ kind: "boolean" }} onPatch={patch} />
        <ProfileField label="Leadership scope" leaf={profile.experience.leadership_scope} path="experience.leadership_scope" editor={{ kind: "text" }} onPatch={patch} />
        <ProfileField label="Management" leaf={profile.experience.management} path="experience.management" editor={{ kind: "boolean" }} onPatch={patch} />
        <ProfileField label="Management scope" leaf={profile.experience.management_scope} path="experience.management_scope" editor={{ kind: "text" }} onPatch={patch} />
      </Group>

      {profile.education.length > 0 && (
        <Group title="Education">
          {profile.education.map((edu, i) => (
            <div key={`education[${i}]`} className="py-1">
              <ProfileField label="Degree" leaf={edu.degree} path={`education[${i}].degree`} editor={{ kind: "text" }} onPatch={patch} />
              <ProfileField label="Institution" leaf={edu.institution} path={`education[${i}].institution`} editor={{ kind: "text" }} onPatch={patch} />
              <ProfileField label="Year" leaf={edu.year} path={`education[${i}].year`} editor={{ kind: "number" }} onPatch={patch} />
            </div>
          ))}
        </Group>
      )}

      {profile.certifications.length > 0 && (
        <Group title="Certifications">
          {profile.certifications.map((cert, i) => (
            <div key={`certifications[${i}]`} className="py-1">
              <ProfileField label="Name" leaf={cert.name} path={`certifications[${i}].name`} editor={{ kind: "text" }} onPatch={patch} />
              <ProfileField label="Issuer" leaf={cert.issuer} path={`certifications[${i}].issuer`} editor={{ kind: "text" }} onPatch={patch} />
              <ProfileField label="Year" leaf={cert.year} path={`certifications[${i}].year`} editor={{ kind: "number" }} onPatch={patch} />
            </div>
          ))}
        </Group>
      )}

      {profile.languages.length > 0 && (
        <Group title="Languages">
          {profile.languages.map((lang, i) => (
            <div key={`languages[${i}]`} className="py-1">
              <ProfileField label="Language" leaf={lang.language} path={`languages[${i}].language`} editor={{ kind: "text" }} onPatch={patch} />
              <ProfileField label="Level" leaf={lang.level} path={`languages[${i}].level`} editor={{ kind: "select", options: LANGUAGE_LEVEL_OPTIONS }} onPatch={patch} />
            </div>
          ))}
        </Group>
      )}

      <Group title="Location & work authorization">
        <ProfileField label="Location" leaf={profile.location.current} path="location.current" editor={{ kind: "text" }} onPatch={patch} />
        {profile.location.work_authorization.length > 0 && (
          <div className="py-2">
            <p className="text-sm font-medium text-neutral-700">Work authorization</p>
            <div className="mt-1 flex flex-wrap gap-2">
              {profile.location.work_authorization.map((item, i) => (
                <div key={`location.work_authorization[${i}]`} className="min-w-0 max-w-full rounded-lg border border-neutral-200 bg-neutral-50 px-3">
                  <ProfileField leaf={item} path={`location.work_authorization[${i}]`} editor={{ kind: "text" }} onPatch={patch} />
                </div>
              ))}
            </div>
          </div>
        )}
        <ProfileField label="Remote preference" leaf={profile.location.remote_preference} path="location.remote_preference" editor={{ kind: "select", options: REMOTE_PREFERENCE_OPTIONS }} onPatch={patch} />
      </Group>
    </>
  );
}
