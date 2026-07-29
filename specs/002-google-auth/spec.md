# Google Auth — Feature Specification

Status: Draft
Source of truth: `PROJECT_CONTEXT.md`, `.specify/memory/constitution.md`, `specs/001-offerly-mvp/spec.md` §4 (sign-up step: "Email/Google OAuth")
Owner: solo developer

## 1. Feature Goal

Let users sign up and log in with their Google account, as a first-class alternative to email/password, so the first-session journey (001 spec, Journey 1) starts with minimal friction.

Feature test (constitution): **"Does this help the user get a job offer faster?"** — Yes: it removes the biggest drop-off point in onboarding (account creation) on the path to the first CV analysis.

## 2. Current State (as of spec writing)

Much of the flow is already scaffolded; this spec defines the finished contract and the gaps to close.

Already in place:

- Frontend "Continue with Google" button on both login and signup (`apps/web/components/auth-form.tsx`) calling `supabase.auth.signInWithOAuth({ provider: "google" })`.
- OAuth callback route (`apps/web/app/(auth)/callback/route.ts`) exchanging `code` for a session and redirecting to `next` (default `/dashboard`).
- Backend auth is provider-agnostic: `AuthGuard` (`apps/api/src/modules/auth/auth.guard.ts`) validates the Supabase JWT via `auth.getUser(token)` — a Google-issued session is identical to an email one. No NestJS code changes are expected.
- Provisioning trigger `handle_new_user` (`supabase/migrations/20260728120200_triggers.sql`) creates the `profiles` row for any new `auth.users` entry, regardless of provider; `onboarding_completed=false` routes new users into onboarding via `apps/web/app/(app)/layout.tsx`.
- Session refresh middleware (`apps/web/middleware.ts`) applies to all routes.

Known gaps this feature closes:

1. **Google provider is not configured** — no Google Cloud OAuth client, no Supabase provider enablement, no redirect-URL allow-listing (local + production).
2. **Silent OAuth failures** — `/callback` redirects to `/login?error=auth` on failure, but the login page never surfaces that parameter; the user sees an unexplained login screen.
3. **Unverified profile provisioning for Google metadata** — the trigger reads `raw_user_meta_data->>'full_name'`; must be verified against what Google actually supplies, with a fallback.
4. **No end-to-end verification** of the full loop (sign up → callback → onboarding → authenticated API call; returning-user login).

## 3. User Stories

### US-1 — Sign up with Google (primary)

As a new user, I want to create my account with one click using my Google account, so I can reach my first CV analysis without inventing a password.

### US-2 — Log in with Google

As a returning user, I want to log in with the same Google account, so I land back in my workspace with all my data.

### US-3 — Understand failures

As a user, if Google sign-in fails or is cancelled, I want a clear message on the login page, so I know what happened and can retry or use email instead.

## 4. Functional Requirements

### FR-1 — Provider configuration

- A Google Cloud OAuth 2.0 client (web application type) exists for the project, with credentials stored only in environment/Supabase dashboard — never in the repo (constitution §III).
- The Google provider is enabled in Supabase Auth for both the local dev stack (`supabase/config.toml` or dashboard) and the hosted project.
- Redirect URL allow-list covers every environment in use: `http://localhost:3000/callback`, the production web origin `/callback`, and the Supabase-hosted callback URL required by the provider.

### FR-2 — Sign-in flow (frontend)

- "Continue with Google" is available on both `/login` and `/signup`; both start the same OAuth flow (Google decides account choice; Supabase creates the user on first sign-in).
- The `next` query parameter is preserved through the round trip so a user who was redirected to login (e.g., from a protected page) returns to their original destination.
- The button shows a pending/disabled state while the redirect is being prepared; a failed `signInWithOAuth` call shows the error inline.

### FR-3 — Callback handling

- `/callback` exchanges the auth `code` for a session server-side and redirects to `next` on success.
- On exchange failure or missing `code`, the user is sent to `/login` with an error indicator, and **the login page displays a human-readable message** for it (closes gap 2).

### FR-4 — Account provisioning

- First Google sign-in creates exactly one `profiles` row and one default `free`/`active` `subscriptions` row (existing triggers).
- `profiles.full_name` is populated from Google metadata when available (`full_name`, falling back to `name`); it may be null otherwise — onboarding collects the name anyway.
- A Google account whose email matches an existing email/password account links to that same user (Supabase default behavior for confirmed emails) — no duplicate users, no data forks.

### FR-5 — Session & backend

- After callback, the session cookie is set and refreshed by middleware exactly as for email auth.
- Every API call from the web app carries the Supabase access token; `AuthGuard` accepts it with no provider-specific branching.
- New Google users land in onboarding (`onboarding_completed=false` redirect); returning users land on `next`/dashboard.

### FR-6 — Sign out

- Signing out works identically regardless of how the user authenticated (existing behavior; verify it holds for OAuth sessions).

## 5. Acceptance Criteria

1. A brand-new user can click "Continue with Google" on `/signup`, complete the Google consent screen, and land in onboarding with a `profiles` row and a default free subscription created.
2. The same user, on a later visit, clicks "Continue with Google" on `/login` and lands on the dashboard with their existing data.
3. A user deep-linked to a protected page (e.g., `/tracker`) who signs in with Google is returned to that page, not the dashboard.
4. Cancelling the Google consent screen or an exchange failure shows a clear error message on `/login` — never a silent redirect.
5. After Google sign-in, authenticated API calls succeed (e.g., the dashboard loads real user data through `AuthGuard`).
6. Signing up with Google using an email that already has an email/password account does not create a second account or lose data.
7. No secrets (Google client secret, Supabase keys) appear in the repo; setup is documented in `RUNNING_LOCALLY.md` / `.env.example`.

## 6. Edge Cases

- **User denies Google consent** → Google redirects back with an error; user lands on `/login` with an explanatory message.
- **Google account with no public name** → `full_name` is null; onboarding step 1 collects it. No crash, no placeholder junk like "null".
- **Email collision** (Google email == existing password account) → accounts link per Supabase behavior; user keeps existing profile, CVs, and subscription.
- **Expired/invalid `code` at callback** (refresh, back button, copied URL) → treated as a failure: redirect to `/login?error=auth` with a visible message, no partial session.
- **OAuth on mobile browsers** → flow works in Safari/Chrome on a phone; no dependency on popups (redirect-based flow only).
- **Supabase Auth unavailable during callback** → same failure path; message suggests retrying.

## 7. Non-Functional Requirements

- **Security (constitution §III):** all authorization stays server-side; the backend never trusts client-supplied identity — only the Supabase-verified JWT. No custom token handling, no JWT parsing on the client beyond the Supabase SDK.
- **RLS:** no policy changes; Google users are ordinary `auth.users` rows and existing owner-only policies apply.
- **Cost:** $0 — Google OAuth and Supabase Auth are free at MVP scale.
- **Privacy:** request only the minimal Google scopes (openid/email/profile). No calendar, contacts, or drive scopes.

## 8. Out of Scope (explicitly)

- Other OAuth providers (GitHub, Apple, LinkedIn) — each is a separate spec if validated.
- One Tap / embedded Google sign-in widgets.
- Account-linking UI (connect/disconnect providers from settings).
- Server-side Google API access (refresh tokens, Gmail/Calendar access).
- Changes to email/password auth, password reset, or email templates beyond sharing the callback/error surface.
- Anonymous/guest sessions.
