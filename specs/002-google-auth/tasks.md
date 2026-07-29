# Google Auth — Implementation Tasks

Plan: `specs/002-google-auth/plan.md` | Spec: `specs/002-google-auth/spec.md`
Complexity scale: **S** (<half day) · **M** (~1 day) · **L** (2–3 days)
Priority principles: code changes first (they're reviewable in a diff), manual dashboard configuration second, verification last. No task may add scope beyond spec §8's boundaries.

---

## Phase 1 — Code changes

### T1.1 Surface OAuth errors on the login page
- **Description:** In `apps/web/components/auth-form.tsx`, read the `error` search param alongside `next`; map `error=auth` to "Google sign-in didn't complete. Please try again, or use email instead." and render it in the existing error alert. Add a `googleLoading` state: disable the Google button and show the `Button` loading spinner while `signInWithOAuth` is in flight; on error, reset and show `error.message`.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** Visiting `/login?error=auth` shows the message; clicking "Continue with Google" disables the button until the redirect happens or an error renders; no new components or UI restructuring.

### T1.2 Handle provider-side errors in the callback
- **Description:** In `apps/web/app/(auth)/callback/route.ts`, add a branch: if `searchParams.get("error")` is present (Google redirected back with consent denied / provider error), redirect to `/login?error=auth` before attempting any code exchange. No other restructuring.
- **Dependencies:** T1.1 (so the destination actually shows something)
- **Complexity:** S
- **Acceptance criteria:** `/callback?error=access_denied` redirects to `/login?error=auth`; valid `code` flow unchanged; missing `code` flow unchanged.

### T1.3 Profile name fallback migration
- **Description:** New migration `supabase/migrations/<timestamp>_google_profile_names.sql`: `create or replace function public.handle_new_user()` with `coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')` for the `full_name` value. Preserve `security definer` and `set search_path = ''`; leave the trigger binding untouched.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** Migration applies cleanly (`supabase db reset` or `db push`); inserting an `auth.users` row with only `name` in metadata yields a `profiles.full_name`; the subscriptions trigger still fires.

---

## Phase 2 — Configuration

### T2.1 Local stack config (`supabase/config.toml`)
- **Description:** Add `[auth.external.google]` with `enabled = true`, `client_id = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID)"`, `secret = "env(SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET)"`. Fix `additional_redirect_urls` (line 163): replace `https://127.0.0.1:3000` with `["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"]`. Do **not** set `skip_nonce_check` unless verification (T4.1) proves it's needed — and then only locally.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** `supabase start` boots with the Google provider enabled; no secret values in the file (env substitution only).

### T2.2 Google Cloud OAuth client (manual)
- **Description:** Google Cloud Console: configure OAuth consent screen (External, "Offerly", default scopes only); create a Web-application OAuth client with authorized redirect URI `https://<project-ref>.supabase.co/auth/v1/callback`. Add developer accounts as test users while the consent screen is in Testing status.
- **Dependencies:** none
- **Complexity:** S
- **Acceptance criteria:** Client ID + secret exist; redirect URI exactly matches the Supabase callback URL; credentials recorded only in the Supabase dashboard / local env, never in the repo.

### T2.3 Supabase hosted project setup (manual)
- **Description:** Dashboard → Authentication → Providers → Google: enable, paste client ID/secret. URL Configuration: Site URL = production origin; add redirect URLs `http://localhost:3000/callback` and `https://<prod-domain>/callback`.
- **Dependencies:** T2.2
- **Complexity:** S
- **Acceptance criteria:** Provider shows enabled; redirect URL list contains both entries; no Vercel preview URLs added (out of scope).

---

## Phase 3 — Documentation

### T3.1 Env placeholders + setup docs
- **Description:** `.env.example`: add a Google OAuth section with `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` placeholders, noted as "local `supabase start` only; hosted project uses the dashboard". `RUNNING_LOCALLY.md` §2: replace the one-line Google mention with a 5-step checklist (consent screen → OAuth client with the **Supabase** callback URI → dashboard credentials → redirect URL allow-list → local `config.toml` + env). Add a troubleshooting entry: "Google button redirects back to login with an error" = redirect URI mismatch, or consent screen in Testing without your account added.
- **Dependencies:** T2.1 (docs must match the final config)
- **Complexity:** S
- **Acceptance criteria:** A developer following only `RUNNING_LOCALLY.md` can configure Google auth end-to-end; placeholders only, no real values.

---

## Phase 4 — Verification

### T4.1 Automated checks stay green
- **Description:** Run `pnpm test`, `pnpm typecheck`, `pnpm lint` after Phase 1–3 changes. No new backend code means no new unit tests; a regression here means a Phase 1 change broke something.
- **Dependencies:** T1.1–T1.3, T2.1, T3.1
- **Complexity:** S
- **Acceptance criteria:** All three commands pass with zero failures.

### T4.2 Manual end-to-end (spec §5 acceptance criteria)
- **Description:** Walk the full matrix against the hosted project: (1) new Google signup → onboarding + one `profiles` row (`full_name` populated) + one free `subscriptions` row; (2) returning login → dashboard with existing data; (3) deep link `/tracker` logged out → Google sign-in → back on `/tracker`; (4) consent denied → `/login` with visible error; invalidated callback (no `code`) → same; (5) dashboard loads real data through `AuthGuard`, no 401s; (6) email collision: Google sign-in with an existing password account's email → same user id, data intact; (7) repeat 1–4 on a phone browser. If local-stack testing hits a nonce error, enable `skip_nonce_check` locally per T2.1 and note it in `decisions.md`.
- **Dependencies:** T4.1, T2.2, T2.3
- **Complexity:** M
- **Acceptance criteria:** All 7 spec acceptance criteria pass; any deviations recorded in `specs/002-google-auth/decisions.md`.

---

## Dependency graph

```
T1.1 ──> T1.2 ──────────────┐
T1.3 ───────────────────────┤
T2.1 ──> T3.1 ──────────────┤
T2.2 ──> T2.3 ──────────────┤
                            v
                          T4.1 ──> T4.2
```

Suggested order: T1.1 → T1.2 → T1.3 → T2.1 → T3.1 → T4.1 (all code/docs, one PR) ‖ T2.2 → T2.3 (manual, any time) → T4.2.
