# Running Offerly Locally

Prerequisites: **Node 24**, **pnpm 11** (`npm i -g pnpm` or `corepack enable`). Optional: Docker + Supabase CLI (local DB), Stripe CLI (webhook testing).

```bash
pnpm install
```

## 1. Environment variables

Two env files are needed — one per app. Get values from your Supabase project (**Project Settings → API**) and Stripe dashboard (**Developers → API keys**, test mode).

### `apps/web/.env.local`

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon / publishable key |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3001` |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` |

### `apps/api/.env`

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `SUPABASE_ANON_KEY` | anon key (used to verify user JWTs) |
| `SUPABASE_SERVICE_ROLE_KEY` | service-role key — **secret, API only** |
| `SUPABASE_JWT_SECRET` | JWT secret (same API settings page) |
| `LLM_PROVIDER_API_KEY` | OpenAI (or compatible) API key |
| `LLM_BASE_URL` | `https://api.openai.com/v1` (default; Groq/Together/etc. work) |
| `LLM_MODEL` | `gpt-4o-mini` (default) |
| `LLM_MAX_CONCURRENCY` | `4` (default) |
| `STRIPE_SECRET_KEY` | `sk_test_...` |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` — from `stripe listen` (see §4), **not** the secret key |
| `STRIPE_PRICE_ID` | `price_...` of the Pro plan (create a product in Stripe test mode) |
| `WEB_URL` | `http://localhost:3000` |
| `PORT` | optional, defaults to `3001` |

The API reads plain `process.env` (no dotenv). Load the file before starting:

```bash
cd apps/api && set -a && source .env && set +a && cd ../..
```

Or run the API with the env inline: `cd apps/api && env $(grep -v '^#' .env | xargs) pnpm dev`.

## 2. Database setup

You need the schema applied once (migrations live in `supabase/migrations/`):

```bash
pnpm dlx supabase login
pnpm dlx supabase link --project-ref <project-ref>
pnpm dlx supabase db push
```

This creates all tables, RLS policies, triggers, and the private `cvs` storage bucket. In the Supabase dashboard also enable **Google OAuth** (Authentication → Providers) if you want the Google button to work; email/password works out of the box.

Alternative — fully local Supabase (requires Docker): `pnpm dlx supabase start` prints local URLs/keys; use those in both env files (`SUPABASE_URL=http://127.0.0.1:54321`) and run `pnpm dlx supabase db reset` to apply migrations.

## 3. Run

```bash
pnpm dev        # turbo starts web (:3000) and api (:3001) together
```

Remember the API needs its env loaded first (see §1). To run one app: `pnpm --filter @offerly/web dev` or `pnpm --filter @offerly/api dev`.

Sanity checks:

- `curl http://localhost:3001/health` → `{"status":"ok"}`
- `curl http://localhost:3001/api/v1/profiles/me` → `401` (auth guard works)
- Open `http://localhost:3000` → landing page; sign up → redirected to `/onboarding`

## 4. Stripe webhooks locally

Checkout works without this, but the subscription only activates via webhook:

```bash
stripe listen --forward-to localhost:3001/api/v1/billing/webhooks/stripe
# copy the printed whsec_... into apps/api/.env as STRIPE_WEBHOOK_SECRET
```

Test upgrade flow: pricing → upgrade → pay with test card `4242 4242 4242 4242`, any future date/CVC → webhook flips your plan to `pro`.

## 5. Tests & checks

```bash
pnpm test        # 37 vitest tests (AI cache/truncation, entitlements matrix, JD heuristics, Stripe webhook logic — all mocked, no credentials needed)
pnpm typecheck
pnpm lint
pnpm build
```

## 6. Manual test walkthrough

1. Sign up → 3-step onboarding → upload a real PDF/DOCX CV (or paste text).
2. CV analysis: score + improvements; run it again unchanged → instant (cache hit, no quota used).
3. `/match`: paste a job description → score, gaps, "Save to tracker".
4. `/tracker`: add/move/delete entries; free tier caps at 10 active.
5. `/coach` and full `/apply`: locked on free (402 → paywall). Upgrade via §4, then retry.
6. Free AI quota is 5 requests/month — exhaust it to see the paywall, or reset by deleting your rows in `usage_records` (SQL editor in Supabase dashboard).

## Troubleshooting

- **401 on every API call** — API env not loaded (`set -a; source .env` step), or wrong `SUPABASE_URL`/anon key.
- **CORS error** — `WEB_URL` in the API env must match the web origin exactly.
- **Analysis returns 422 `no_text_layer`** — the PDF is a scan; paste the text instead (by design).
- **AI 503s** — bad `LLM_PROVIDER_API_KEY`/`LLM_BASE_URL`, or the provider account is out of quota (`provider rate/quota limit reached` = add credits or switch provider via `LLM_BASE_URL`, e.g. Groq's free tier `https://api.groq.com/openai/v1` with `LLM_MODEL=llama-3.3-70b-versatile`). Features degrade gracefully, other pages keep working.
- **Upgrade doesn't unlock Pro** — webhook not forwarded (§4) or `STRIPE_WEBHOOK_SECRET` mismatch. Webhook without a valid signature returns 400 by design.
