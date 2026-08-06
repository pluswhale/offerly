# Offerly MVP — Product Specification

Status: Draft
Source of truth: `PROJECT_CONTEXT.md`, `.specify/memory/constitution.md`
Owner: solo developer

## 1. Product Goal

Build an AI Career Copilot SaaS that helps candidates get job offers faster.

Every feature in this spec must answer: **"Does this help the user get an offer faster?"** Anything that doesn't is out of scope.

### Success criteria for MVP validation

- Users complete onboarding and perform at least one CV analysis in their first session.
- Users return to track applications (Job Tracker retention signal).
- Free-to-Pro conversion intent is measurable (paywall hits, upgrade clicks).
- LLM spend per active user stays below Pro revenue per user (constitution §V).

## 2. Target Users & Personas

### Persona A — "Alex, the Active Applicant" (primary)

- Software developer, 2–6 years experience, applying to 5–15 jobs per week.
- Pain: tailoring each application is exhausting; sends generic CVs and gets silence.
- Goal: high-quality, tailored applications at volume without burning out.
- Device: desktop during focused work, mobile for quick checks.

### Persona B — "Maria, the International Candidate"

- Tech professional relocating or seeking remote/sponsored roles abroad.
- Pain: unfamiliar with target-market CV norms, unsure which roles are realistic, visa questions.
- Goal: understand how she compares to local expectations and apply confidently.
- Device: mixed; often mobile-first.

### Persona C — "Dan, the Passive Explorer"

- Employed tech professional, casually browsing, applies to 1–2 jobs a month.
- Pain: rusty CV, no interview practice in years, low urgency.
- Goal: know his market value and be ready when the right role appears.
- Device: mostly mobile, short sessions.

### Persona D — "Sarah, the Career Switcher"

- Moving into tech from an adjacent field.
- Pain: doesn't know how to translate her experience, low confidence, no feedback loop.
- Goal: actionable guidance on positioning herself for entry tech roles.

Primary design target is **Alex**; B/C/D must not be blocked, but no feature is built solely for them in MVP.

## 3. User Journeys

### Journey 1 — First session (activation)

1. Lands on marketing page → signs up (email/Google).
2. Onboarding: name, target role, uploads CV (see §5).
3. Immediately gets first CV analysis with 3 top improvements → "aha" moment.
4. Prompted to add a first job to the tracker or paste a job description for a match score.
5. Lands on Dashboard with clear next action.

### Journey 2 — Applying to a job (core loop)

1. Pastes a job description (or URL) → Job Match score vs. current CV.
2. Sees gaps and recommendations.
3. (Pro) Uses AI Apply Assistant to generate a tailored cover letter and application answers.
4. Saves the job to Job Tracker with status "Applied".
5. Dashboard updates progress.

### Journey 3 — Interview & offer stage

1. Moves a tracked job to "Interview".
2. (Pro) Asks AI Coach for interview prep based on the job + CV context.
3. Moves to "Offer" / "Rejected"; sees funnel stats on Dashboard.

### Journey 4 — Hitting the paywall (conversion)

1. Free user exhausts AI requests or tries a Pro feature.
2. Sees contextual paywall (what they'd get, priced) → upgrades via Stripe or waits for quota reset.

## 4. Onboarding

Principles: minimal friction, collect only what's needed, progressive profiling, introduce features at the right moment.

### Step-by-step

| Step | Collected | Why now |
|---|---|---|
| 1. Sign up | Email/Google OAuth | Minimum viable account |
| 2. Basics | Name, current role, target role | Personalizes all AI output |
| 3. CV upload | CV file or paste text | Unlocks the "aha" (first analysis) — skippable, but default path |
| 4. First analysis | — (system action) | Immediate value, no more questions asked |

- Onboarding must be completable in under 2 minutes. No more than 3 data-collection steps.
- **Progressive profiling**: experience level, location/visa situation, salary expectations are collected later — when relevant (e.g., first AI Coach use asks for context it's missing; Job Match prompts for location if a job requires it).
- **Just-in-time feature introduction**: each feature is introduced with a one-line tooltip the first time it's reachable — no product tour, no modal carousel.
- Skipping CV upload is allowed; Dashboard then leads with "Upload your CV" as the primary action.

## 5. Core MVP Features

### 5.1 Dashboard

**User problem:** Job searching is chaotic; users lose track of what to do today and whether they're making progress.

**User story:** As a job seeker, I want a daily overview of my pipeline, progress, and the single most valuable next action, so I always know what to do next.

**Acceptance criteria:**

- Shows: pipeline summary (counts per tracker status), recent activity, AI usage/quota state, and one prioritized "next best action" card (e.g., "Follow up on 3 applications older than 7 days", "Finish your CV improvements").
- Next action is derived from actual user data; if the account is empty, it points to CV upload.
- Loads on mobile and desktop without horizontal scrolling; usable above the fold on a phone.

**Edge cases:**

- New user with no data → empty-state onboarding card, not blank widgets.
- All applications in "Rejected" → next action suggests CV/match improvement, not "keep waiting".
- LLM quota exhausted → AI-powered suggestions replaced by cached/rule-based guidance (constitution §V graceful degradation).

**Free vs paid:** Dashboard is identical; the difference is only AI quota reflected in usage display. (The Dashboard is the retention engine — gating it would hurt validation.)

---

### 5.2 CV Analyzer

> **Superseded in part by `specs/003-ai-pipeline-redesign/spec.md`:** analysis now runs on the extracted Candidate Profile (`cv-review.v2`), with per-field evidence and user corrections.

**User problem:** Candidates get rejected without feedback and don't know what's wrong with their CV.

**User story:** As a candidate, I want an honest, specific assessment of my CV with concrete improvements, so I can fix it instead of guessing.

**Acceptance criteria:**

- Accepts PDF/DOCX upload or pasted text; extracts text reliably for standard CV formats.
- Returns: overall score, section-by-section feedback (impact, clarity, keywords, formatting), and a prioritized list of concrete improvements.
- Free tier: one full analysis of one CV version (basic depth). Pro: unlimited analyses, deeper analysis, re-analysis after edits with diff-style progress ("you fixed 2 of 5 issues").
- Results are cached per CV content hash (constitution §V): re-uploading an unchanged CV costs nothing.
- Users can store multiple named CVs; exactly one is **active** at a time (newly uploaded CV becomes active).
- A CV selector sits at the top of every CV-dependent section (CV Analyzer, Job Match, Apply Assistant, AI Coach); choosing a CV there switches the active CV for the whole account.
- CVs can be renamed and deleted.

**Edge cases:**

- Unreadable/scanned PDF (no text layer) → clear error + paste-text fallback.
- CV not in English → detect language; analyze in-place but warn that most target markets expect English (no translation feature in MVP).
- Very long CV → truncate intelligently, tell the user what was analyzed.
- Prompt-injection text inside a CV is treated as data, never as instructions (constitution §III).
- Free user at the 1-CV storage limit uploads another CV → offer a choice: replace the existing CV or upgrade to Pro.
- Deleting the active CV → no active CV remains; CV-dependent sections show the upload prompt again.

**Free vs paid:**

| Free | Pro |
|---|---|
| 1 analysis, 1 CV version, 1 stored CV, basic depth | Unlimited analyses, versions & stored CVs, deep analysis, progress tracking across versions |

---

### 5.3 Job Match

> **Superseded in part by `specs/003-ai-pipeline-redesign/spec.md`:** the score is now a deterministic weighted report over per-requirement verdicts (MATCH/PARTIAL/UNKNOWN/MISSING) against a structured job profile, not a single LLM call.

**User problem:** Candidates waste time applying to jobs where they're not competitive, or misjudge fit entirely.

**User story:** As a candidate, I want to compare my CV against a job description and get a match score with the gaps explained, so I can prioritize where to apply and what to fix.

**Acceptance criteria:**

- Input: pasted job description (URL import only if a simple fetch works reliably; paste is the guaranteed path).
- Output: 0–100 match score, matched strengths, missing keywords/requirements, and 2–3 recommendations to improve fit.
- Requires an uploaded CV; if missing, prompts to upload first (progressive profiling hook).
- Matches against the active CV; the CV selector (§5.2) at the top of the section switches it.
- Match results are saved and linked to the job if the user adds it to the tracker.

**Edge cases:**

- Job description is too short/vague → warn "low confidence" rather than returning a fake-precise score.
- Non-job text pasted → detect and reject politely.
- CV in a different language than the JD → score with a warning.
- Duplicate: same CV hash + same JD hash → serve cached result, don't re-bill quota.

**Free vs paid:**

| Free | Pro |
|---|---|
| Limited number of matches per month (counts against AI quota) | Unlimited matches + deeper gap analysis |

---

### 5.4 AI Apply Assistant

**User problem:** Writing tailored cover letters and application answers for every job is the most time-consuming part of applying — so most people skip it and send generic applications.

**User story:** As an active applicant, I want a tailored cover letter and strong answers to application questions based on my CV and the specific job, so every application is customized without hours of work.

**Acceptance criteria:**

- Generates: tailored cover letter, answers to free-text application questions, and vacancy-specific recommendations (what to emphasize).
- Output is editable in place before copying; regeneration with an instruction ("shorter", "more formal") is supported.
- Grounded in the user's actual CV — must not invent experience; clearly flags when the job asks for something the CV doesn't show.
- Uses the active CV; the CV selector (§5.2) at the top of the section switches it.
- **Pro-only feature** (with a free-tier preview: one watermarked/sample generation so the value is felt before paying).

**Edge cases:**

- Job asks for experience the user lacks → assistant highlights the gap honestly instead of fabricating.
- Very long generated text → streaming or progressive display; never a frozen spinner for >10s without feedback.
- User regenerates repeatedly → rate-limited by plan; each regeneration counts as an AI request.
- Company/role name unparseable from JD → ask the user to fill them manually.

**Free vs paid:**

| Free | Pro |
|---|---|
| 1 sample generation (preview) | Full assistant: letters, answers, recommendations, regeneration |

---

### 5.5 Job Tracker

**User problem:** Applications spread across email, spreadsheets, and memory; follow-ups get missed.

**User story:** As a job seeker, I want a simple pipeline of my applications with statuses, so nothing falls through the cracks.

**Acceptance criteria:**

- Kanban or list view with statuses: **Saved → Applied → Interview → Offer / Rejected**.
- CRUD for entries: company, role, link, notes, date applied; drag or dropdown status changes.
- Free: up to **10 active applications**. Pro: unlimited.
- Entries can link to a saved Job Match result and generated Apply Assistant outputs.
- Works fully without AI — the tracker is a pure CRUD feature, always available even when AI quota is exhausted.

**Edge cases:**

- Free user at the 10-application limit → clear upgrade prompt; existing entries remain fully usable (never locked).
- Deleting an entry with linked AI artifacts → confirm; linked artifacts are kept or deleted per user choice (simplest: delete with entry).
- Offline/poor connection → optimistic UI with queued mutations is acceptable; silent data loss is not.

**Free vs paid:**

| Free | Pro |
|---|---|
| 10 active applications | Unlimited applications |

---

### 5.6 AI Coach

> **Superseded in part by `specs/003-ai-pipeline-redesign/spec.md`:** the coach (`coach.v2`) uses a budgeted context manifest built from the Candidate Profile and match summaries — raw CV text is no longer injected.

**User problem:** Generic career advice doesn't account for the person's actual CV, goals, and pipeline; human coaching is unaffordable.

**User story:** As a candidate, I want personalized career guidance that knows my CV, target role, and application history, so advice is relevant to my situation.

**Acceptance criteria:**

- Conversational interface; every response grounded in user context (CV, target role, tracked jobs).
- Uses the active CV as context; the CV selector (§5.2) at the top of the section switches it.
- **Pro-only.** Free users see a locked preview with one example interaction.
- On first use, asks for any missing context (progressive profiling) instead of blocking onboarding earlier.
- Coach suggests concrete actions that link back into the product ("Run a Job Match for this role", "Update your CV summary").

**Edge cases:**

- Off-topic/harmful requests → polite refusal with redirect to career topics.
- Empty user context (no CV) → coach prompts to upload CV before giving personalized advice; can still answer generic questions.
- Long conversations → context window managed (summarize older turns); user told when context was compacted.

**Free vs paid:**

| Free | Pro |
|---|---|
| Locked preview (1 example) | Full conversational coach with user context |

## 6. Subscription Model

### Free — $0

- Limited AI requests per month (shared quota across CV Analyzer, Job Match; exact number set at implementation, default: **5/month**)
- Basic CV analysis: 1 analysis, 1 CV version
- 1 stored CV
- Job Tracker: up to 10 active applications
- Dashboard: full access
- Apply Assistant: 1 sample generation
- AI Coach: locked preview

### Pro — subscription (Stripe; crypto payments are a documented future extension, not MVP scope)

- Unlimited CV analyses and versions, deep analysis, progress tracking
- Unlimited stored CVs
- Unlimited Job Match with deep gap analysis
- Full AI Apply Assistant
- Unlimited applications in Job Tracker
- AI Coach
- Advanced recommendations across all features

### Rules

- Feature gating is enforced server-side via the entitlement model (constitution §VI), never only in the UI.
- AI spend per user must stay below Pro revenue per user; expensive operations are the Pro-gated ones (constitution §V).
- Downgrade: Pro → Free never deletes data; over-limit tracker entries become read-only until within limit or re-upgraded.

## 7. UX Principles

- **Premium SaaS feel:** generous whitespace, restrained color palette with one strong accent, crisp typography, subtle micro-animations. Inspired by the polish of modern products like Linear, Notion, and Vercel — not their feature count.
- **Simple:** one primary action per screen. No feature exists without a user reaching it in ≤2 taps from the Dashboard.
- **Mobile-first, desktop-optimized:** layouts designed for phones first, then enhanced for desktop (multi-column dashboard, wider editor for Apply Assistant). No horizontal scrolling, touch targets ≥44px.
- **Fast feels premium:** skeleton loaders, optimistic UI for tracker operations, streaming for long AI outputs.
- **Honest AI:** scores and AI output always show what they're based on; the product never fabricates confidence.
- **Consistent design system:** one component library, one spacing scale, dark/light mode only if nearly free — otherwise light mode only for MVP.

## 8. Out of Scope (explicitly)

Rejected to protect MVP validation:

- Job board aggregation / auto-import from LinkedIn, Indeed, etc.
- Browser extension (architecture keeps it possible; nothing built — constitution §II)
- Interview mock video/voice practice
- Team/recruiter accounts, sharing, collaboration
- Resume builder/templates (we analyze, we don't typeset)
- Crypto payments (documented future, no code)
- Notifications beyond in-app (no email digests/push in MVP)
- Localization/i18n of the UI (analysis works on non-English CVs; the UI is English)
- Native mobile apps
