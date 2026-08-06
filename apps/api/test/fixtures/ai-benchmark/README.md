
# AI benchmark dataset (spec 003 §10, T2.6)

Offline benchmark harness for the AI pipeline's prompt templates. It runs the
real extraction path (`extractCandidateProfile` → S2 verifier → conditional S3
`runValidation`) through the real `AiService` gateway for every fixture CV and
scores the result against human-labeled expectations.

## Layout

```
cvs/<name>.cv.txt                     anonymized, invented CV text (no real PII)
cvs/<name>.expected.json              human labels: fields that MUST be extracted,
                                      fields that MUST stay unknown
jds/<name>.jd.txt + .expected.json    JD texts + expected required skills
pairs/<cv>--<jd>.verdicts.expected.json  human-labeled expected verdict per
                                      requirement id for a CV×JD match (T3.3);
                                      covers ALL requirements — pre-pass and
                                      LLM-classified alike. The "--" separator
                                      keeps recorded/ prefixes collision-free.
recorded/<name>.<templateVersion>.json  recorded provider responses for offline replay
                                      (CV name → cv-extract/cv-validate, JD name →
                                      jd-extract, pair name → match-requirements)
reports/<templateVersion>.md          generated report — committed per prompt change (T6.2)
```

Current CV fixtures: `sparse-junior`, `senior-multirole`, `non-english-russian`,
`keyword-stuffed`. Current verdict pairs: `senior-multirole` and `sparse-junior`
matched against `senior-backend-fintech` and `vague-rockstar` (the vague JD has
zero requirements — it asserts the no-LLM-call path).

### `expected.json` format

```json
{
  "description": "what this fixture exercises",
  "stated": {
    "headline.title": "Junior Frontend Developer",
    "experience.leadership": true,
    "skills.programming_languages": ["JavaScript"],
    "languages": ["Polish", "English"]
  },
  "unknown": ["skills.databases", "location.remote_preference", "certifications"]
}
```

- Scalar paths resolve to an Evidenced leaf and must be `stated` with a matching
  value (compared after the same normalization as S2).
- Array paths (`skills.*` groups, `languages`, `experience.industries`,
  `experience.domains`, `location.work_authorization`, `certifications`,
  `education`, `roles`) list every expected member — extracted members not in
  the list count against precision. List a group in `stated` only with its full
  expected membership.
- `unknown` entries must come back `status: "unknown"` (scalars) or as empty
  arrays — never invented (spec AC-2).

## Running

```bash
pnpm bench:ai                                  # replay mode (default): offline, uses recorded/
AI_BENCH_MODE=live pnpm bench:ai               # live calls to the configured provider
AI_BENCH_MODE=record pnpm bench:ai             # live + (re)write recorded/*.json
AI_BENCH_REPORT=/tmp/bench.md pnpm bench:ai    # custom report path
```

Live/record modes use the app's provider env (`LLM_BASE_URL`,
`LLM_PROVIDER_API_KEY`, `LLM_MODEL`). Replay mode needs no API key and no
network — it is what CI (`apps/api/test/ai-benchmark.spec.ts`) exercises.

The script exits non-zero when a hard floor fails (100% schema validity, 100%
evidence-verbatim rate, zero invented expected-unknown fields, 100% verdict
accuracy on the recorded CV×JD pairs — recordings encode the labels, so the
floor's purpose is catching regressions; UNKNOWN↔MISSING confusions are counted
separately in the report).

## Adding a fixture

1. Drop an invented CV at `cvs/<name>.cv.txt` (realistic, no real PII).
2. Write `cvs/<name>.expected.json` (see format above).
3. Record the response: `AI_BENCH_MODE=record pnpm bench:ai` (needs provider
   credentials), or hand-craft `recorded/<name>.cv-extract.v1.json` — every
   `stated` item's `evidence` must be a verbatim span of the CV text, or the
   CI floors fail. Keep confidences ≥ 0.7 and dated roles consistent with
   `total_years_experience`, otherwise S3 gets flagged items and a
   `recorded/<name>.cv-validate.v1.json` is needed too.
4. Run `pnpm bench:ai` and check the report.

## Adding a verdict pair (T3.3)

1. Pick a CV and a JD fixture; ensure both have recorded extractions
   (`recorded/<cv>.cv-extract.v1.json`, `recorded/<jd>.jd-extract.v1.json`).
2. Write `pairs/<cv>--<jd>.verdicts.expected.json` with the expected verdict
   (`match|partial|unknown|missing`) for EVERY requirement id in the JD
   profile — pre-pass-resolved and LLM-classified alike. Honor spec §FR-7:
   `unknown` only when the profile is silent, `missing` only with positive
   counter-evidence.
3. Hand-craft `recorded/<cv>--<jd>.match-requirements.v1.json` (or record it
   live): exactly one verdict per requirement the pre-pass leaves unresolved,
   citing only paths that exist in the CV's recorded profile — otherwise the
   template's validator rejects it and the pair run fails. Check which
   requirements stay unresolved with a quick `resolveBatch` run.
4. Run `pnpm bench:ai` — verdict accuracy must stay 100%.

## Prompt changes

Any change to `prompts/` must be followed by `pnpm bench:ai` and an updated
`reports/<templateVersion>.md` committed alongside the prompt diff — the report
is the regression artifact T6.2 will gate on in CI. When the model/provider
changes materially, re-record (`AI_BENCH_MODE=record`) and review the diff of
`recorded/` like code.

Note: recordings that derive `total_years_experience` from a role ending in
"present" drift ~1 year per calendar year; if the consistency check starts
flagging a fixture years from now, re-record it.
