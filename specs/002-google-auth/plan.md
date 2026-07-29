# Google Auth — Technical Implementation Plan

Spec: `specs/002-google-auth/spec.md`
Constitution: `.specify/memory/constitution.md` (binding — especially §III security, KISS/YAGNI)

## 0. Strategy

Google auth is ~70% built (button, callback route, provider-agnostic backend guard, provisioning triggers). This plan closes the four gaps from spec §2 with **small, reviewable diffs and zero backend code changes**:

1. Provider configuration (Google Cloud + Supabase dashboard + local `config.toml`) — mostly manual, documented.
2. OAuth failure surfacing on `/login` — small `AuthForm` change.
3. `full_name` fallback in the `handle_new_user` trigger — one tiny migration.
4. Docs (`.env.example`, `RUNNING_LOCALLY.md`) + end-to-end verification.

Anything not on this list is out of scope (spec §8). No refactoring of existing auth code.

## 1. Phase 1 — Provider configuration

### 1.1 Google Cloud Console (manual)

- Create/reuse a Google Cloud project → **APIs & Services → OAuth consent screen**: External, app name "Offerly", no extra scopes (openid/email/profile only, per spec §7).
- **Credentials → Create OAuth client ID**, type "Web application".
- Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback` — this is **Supabase's** callback, not the app's `/callback`. (Common failure point; goes in the docs.)
- While the consent screen is in "Testing" status, add the developer's Google account as a test user, or publish the app. Note this in docs — it is the most likely "it doesn't work" cause.
- Client ID/secret live only in the Supabase dashboard and local env — never in the repo (constitution §III).

### 1.2 Supabase hosted project (manual, dashboard)

- **Authentication → Providers → Google**: enable, paste client ID + secret.
- **Authentication → URL Configuration**: Site URL = production web origin; add redirect URLs `http://localhost:3000/callback` and `https://<prod-domain>/callback`.
- Vercel preview deployments are **not** covered (each would need its own redirect URL — YAGNI for MVP).

### 1.3 Local dev stack (code: `supabase/config.toml`)

- Add an `[auth.external.google]` block (mirroring the existing `[auth.external.apple]` template at `supabase/config.toml:322`):

  ```toml
  [auth.external.google]
  enabled = true
  client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"
  secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"
  ```

- Fix the existing redirect allow-list: `additional_redirect_urls` currently holds `https://127.0.0.1:3000` (`supabase/config.toml:163`) — wrong scheme and missing the callback path. Replace with `["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"]`.
- If the local flow fails with a nonce error (known quirk for local Google sign-in), set `skip_nonce_check = true` in the local block only — never in the hosted project. Decide empirically during verification; don't preemptively weaken the check.

## 2. Phase 2 — Frontend error surfacing (code)

File: `apps/web/components/auth-form.tsx`

- Read the `error` search param (the component already uses `useSearchParams` for `next`). Map `error=auth` to: "Google sign-in didn't complete. Please try again, or use email instead." Render it in the existing error alert block (`auth-form.tsx:107-111`). No new UI components.
- Add a pending state for the Google button: `googleLoading` state, set before `signInWithOAuth`, disable the button + show spinner via the existing `Button` `loading` prop. On error, clear it and show `error.message` (existing behavior).

File: `apps/web/app/(auth)/callback/route.ts`

- One addition: if Google itself redirected back with an error (`searchParams.get("error")` — e.g. consent denied), take the same failure path (`/login?error=auth`) instead of silently falling through. The existing `!error` / missing-`code` handling already covers the rest — do not restructure this file.

## 3. Phase 3 — Profile name fallback (one migration)

New file: `supabase/migrations/<timestamp>_google_profile_names.sql`

- `create or replace function public.handle_new_user()` with `coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')` as the `full_name` value. Everything else in the function unchanged (`security definer`, `set search_path = ''` preserved).
- No RLS changes, no schema changes. Existing trigger binding is untouched (replacing the function body is sufficient).
- Rollback note: re-apply the previous function body from `20260728120200_triggers.sql`.

## 4. Phase 4 — Docs & env placeholders

- `.env.example`: add a Google OAuth section with `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` placeholders, marked "local `supabase start` only; hosted project uses the dashboard".
- `RUNNING_LOCALLY.md` §2: expand the one-line Google mention (`RUNNING_LOCALLY.md:58`) into a 5-step checklist: consent screen → OAuth client with the Supabase callback redirect URI → paste credentials in dashboard → allow-list redirect URLs → (local stack) `config.toml` + env vars. Add a troubleshooting line: "Google button spins then returns to login" = redirect URI mismatch or consent screen in Testing mode without your account added.

## 5. Phase 5 — Verification (no new backend code)

Backend correctness is already covered by design: `AuthGuard` validates the Supabase JWT via `auth.getUser(token)` and never inspects the provider — a Google session is indistinguishable from an email one. Per constitution §IV, test what breaks the business; the auth path already has coverage, so:

- Run the existing suite (`pnpm test`, `pnpm typecheck`, `pnpm lint`) — must stay green.
- Manual end-to-end against spec §5 acceptance criteria, in order:
  1. New user: `/signup` → Continue with Google → consent → lands in `/onboarding`; verify one `profiles` row (`full_name` populated when Google provides it) and one `free`/`active` `subscriptions` row in the dashboard SQL editor.
  2. Returning user: sign out → `/login` → Continue with Google → lands on `/dashboard` with existing data.
  3. Deep link: open `/tracker` logged out → sign in with Google → returns to `/tracker`, not `/dashboard` (the `next` round trip).
  4. Failure: deny consent on the Google screen → lands on `/login` with the visible error message (not a silent redirect). Repeat with an invalidated callback URL (remove `code`) for the exchange-failure path.
  5. Authenticated API: dashboard loads real data (200s through `AuthGuard`), no 401s.
  6. Email collision: create an email/password account, sign out, sign in with Google using the same email → same user id, no duplicate profile, data intact.
- Repeat 1–4 on a phone browser (redirect flow, no popups — spec §6).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Redirect URI mismatch (Supabase callback vs app callback confusion) | Explicit URIs in docs checklist (§4); verification step 1 catches it immediately |
| Consent screen stuck in "Testing" → strangers can't sign up in prod | Docs note; publish consent screen before launch |
| `skip_nonce_check` needed locally | Only enable in `config.toml` (local), never hosted; decided by testing, not guessing |
| Over-engineering creep (One Tap, provider settings UI) | Spec §8 out-of-scope list is binding |

## 7. Deliverables checklist

- [ ] `supabase/config.toml` — `[auth.external.google]` + fixed `additional_redirect_urls`
- [ ] `apps/web/components/auth-form.tsx` — `error` param surfaced, Google button pending state
- [ ] `apps/web/app/(auth)/callback/route.ts` — provider-error branch
- [ ] `supabase/migrations/<timestamp>_google_profile_names.sql` — `full_name` coalesce
- [ ] `.env.example`, `RUNNING_LOCALLY.md` — Google setup docs
- [ ] Google Cloud + Supabase dashboard configured (manual)
- [ ] `pnpm test` / `typecheck` / `lint` green; spec §5 acceptance criteria 1–7 manually verified
