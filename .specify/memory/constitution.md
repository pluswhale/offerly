# OfferPilot Engineering Constitution

Source of truth: `PROJECT_CONTEXT.md`. Built and maintained by a solo developer with a ≤$100 initial budget. Every principle below exists to ship the MVP fast, keep costs near zero, and stay easy to change alone.

## Core Product Principle

Every feature must answer: **"Does this help the user get a job offer faster?"** If no, it waits.

## I. Coding Standards

- TypeScript everywhere, strict mode, no `any` without a comment justifying it.
- Next.js 16 / React 19 frontend; NestJS backend; Supabase PostgreSQL.
- Clean code, SOLID, DRY — but pragmatically: three similar lines beat a premature abstraction.
- KISS and YAGNI are binding. Build only what the current feature needs. No speculative configurability, plugin systems, or "just in case" layers.
- Match the surrounding file's style. Consistency within a module beats personal preference.
- Small, reviewable diffs. No opportunistic refactors or reformatting mixed into feature work.

## II. Architecture Principles

- **Modular monolith, not microservices.** One NestJS backend with clearly bounded modules (auth, cv, jobs, applications, ai, billing). Microservices are explicitly premature.
- Modules communicate through explicit interfaces; no cross-module imports of internals. This keeps a future extraction possible without ever paying for it now.
- Frontend follows Next.js conventions: server components by default, client components only where interactivity requires them.
- One database (Supabase PostgreSQL) with a schema per domain area only if it stays free and simple; default is a single schema with clear table naming.
- Browser-extension support is a *future* concern: keep business logic in the backend API so the extension is a thin client later. Do not build extension plumbing now.

## III. Security Rules

- Never trust the client. All authorization checks happen server-side.
- Use Supabase Row Level Security (RLS) on every user-data table; user data is only ever accessible to its owner.
- Secrets live in environment variables only — never in code, never in the repo, never logged.
- Validate all external input at the API boundary (DTOs with validation in NestJS).
- User-uploaded content (CVs, job descriptions) is treated as untrusted: sanitize before rendering, size-limit before processing.
- Prompt-injection awareness: user-provided text sent to an LLM is data, not instructions. System prompts must never interpolate raw user input into privileged instruction sections.
- Stripe webhooks verified by signature; payment state changes only via webhook handlers, never via client calls.

## IV. Testing Strategy

- Test what breaks the business, not everything. Priority order:
  1. Billing / feature-gating logic (wrong = lost money or angry users)
  2. Auth and data isolation (wrong = security incident)
  3. AI pipeline core logic: prompt construction, caching, response parsing
  4. Critical user flows as a small set of end-to-end smoke tests
- Unit tests for pure logic (scoring, matching, gating). Integration tests for API + DB. E2E only for the happy paths of the 6 MVP features.
- No coverage targets. A solo developer measuring coverage is measuring the wrong thing.
- Every bug fix ships with a test that would have caught it.
- LLM outputs are non-deterministic: test prompt assembly and response *handling*, not exact model output. Use recorded fixtures for LLM responses in tests.

## V. AI Cost Optimization Principles

- **Cache aggressively.** LLM responses are cached keyed by a hash of (prompt template + normalized input). Identical CV/JD pairs never hit the API twice.
- Use the cheapest model that passes a manual quality check for each task; escalate to stronger models only for tasks where quality measurably matters.
- Cap tokens: bound input size (truncate CVs/JDs intelligently) and set `max_tokens` on every call.
- Log every LLM call's token usage and cost. A weekly cost review is part of the routine while on the ≤$100 budget.
- Feature-gate expensive AI operations: free tier gets limited/cheaper AI usage; premium tiers fund heavier usage. AI spend must never exceed revenue per user.
- Batch and debounce: never call the LLM on every keystroke; analyze on explicit user action.
- Have a graceful degradation path: if the AI provider is down or over budget, the feature degrades (cached/generic guidance) instead of failing or overspending.

## VI. SaaS Scalability Principles

- **Scale by design, not by infrastructure.** Stateless backend, connection-pooled Postgres, horizontally deployable — but run on the smallest free/cheap tier until metrics say otherwise.
- Free hosting first: Vercel, Supabase, Railway/Render free tiers. No paid infrastructure before revenue.
- Subscription-ready from day one: Stripe integration with feature gating built into the entitlement model, not bolted on. Crypto payments are a documented future extension, not current code.
- Multi-tenant by user ID on every table and query. No shared mutable state between users.
- Long-running AI work is async (queue or background job) so request latency stays low and retries are possible.
- Monitor the basics: error tracking, LLM spend, and request latency. No enterprise observability stack — one tool that is free or nearly free.
- Optimize only measured bottlenecks. Premature scaling work is rejected the same way premature features are.

## Governance

- This constitution overrides habit and convenience. When a principle conflicts with a shortcut, the principle wins — or the constitution is amended explicitly in the same PR.
- Any amendment requires a one-line rationale referencing a real need, not a hypothetical one.
- Complexity must be justified: if a design can't be explained to yourself in a paragraph, it's too complex for this stage.
