-- T10.1: Stripe webhook idempotency — the handler inserts the event id first;
-- a unique violation means the event was already processed (replayed webhook).
-- Service-role only (RLS enabled, no policies), like llm_cache.

create table public.processed_webhook_events (
  event_id text primary key,
  created_at timestamptz not null default now()
);

alter table public.processed_webhook_events enable row level security;
