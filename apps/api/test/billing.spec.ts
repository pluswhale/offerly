import { BadRequestException } from "@nestjs/common";
import type Stripe from "stripe";
import { describe, expect, it, vi } from "vitest";
import { BillingService } from "../src/modules/billing/billing.service.js";
import type { PaymentProvider, SubscriptionEvent } from "../src/modules/billing/payment-provider.js";
import { StripePaymentProvider } from "../src/modules/billing/stripe-payment.provider.js";
import { SupabaseService } from "../src/modules/supabase/supabase.service.js";
import { FakeSupabaseClient } from "./helpers/fake-supabase.js";

const URLS = {
  successUrl: "http://localhost:3000/ok",
  cancelUrl: "http://localhost:3000/cancel",
  portalReturnUrl: "http://localhost:3000/back",
};

function makeStripe(constructEvent: ReturnType<typeof vi.fn>): Stripe {
  return { webhooks: { constructEvent } } as unknown as Stripe;
}

describe("StripePaymentProvider webhook handling (T10.1)", () => {
  it("rejects a forged signature", async () => {
    const stripe = makeStripe(
      vi.fn(() => {
        throw new Error("No signatures found matching the expected signature");
      }),
    );
    const provider = new StripePaymentProvider(stripe, "whsec_test", URLS);
    await expect(provider.handleWebhook(Buffer.from("{}"), "bad-sig")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("maps checkout.session.completed → pro/active", async () => {
    const stripe = makeStripe(
      vi.fn(() => ({
        id: "evt_1",
        type: "checkout.session.completed",
        data: {
          object: {
            client_reference_id: "user-1",
            customer: "cus_1",
            subscription: "sub_1",
            metadata: {},
          },
        },
      })),
    );
    const provider = new StripePaymentProvider(stripe, "whsec_test", URLS);
    const event = await provider.handleWebhook(Buffer.from("{}"), "sig");
    expect(event).toMatchObject({
      eventId: "evt_1",
      userId: "user-1",
      providerCustomerId: "cus_1",
      providerSubscriptionId: "sub_1",
      plan: "pro",
      status: "active",
    });
  });

  it("maps customer.subscription.deleted → free/canceled", async () => {
    const stripe = makeStripe(
      vi.fn(() => ({
        id: "evt_2",
        type: "customer.subscription.deleted",
        data: {
          object: {
            id: "sub_1",
            customer: "cus_1",
            status: "canceled",
            metadata: { user_id: "user-1" },
            items: { data: [{ current_period_end: 1_800_000_000 }] },
          },
        },
      })),
    );
    const provider = new StripePaymentProvider(stripe, "whsec_test", URLS);
    const event = await provider.handleWebhook(Buffer.from("{}"), "sig");
    expect("ignored" in event).toBe(false);
    if ("ignored" in event) return; // type narrowing
    expect(event.plan).toBe("free");
    expect(event.status).toBe("canceled");
    expect(event.currentPeriodEnd).toBe(new Date(1_800_000_000 * 1000).toISOString());
  });

  it("acknowledges unhandled event types as ignored (no Stripe retries)", async () => {
    const stripe = makeStripe(vi.fn(() => ({ id: "evt_3", type: "invoice.paid", data: { object: {} } })));
    const provider = new StripePaymentProvider(stripe, "whsec_test", URLS);
    const event = await provider.handleWebhook(Buffer.from("{}"), "sig");
    expect(event).toEqual({ eventId: "evt_3", ignored: true });
  });
});

describe("BillingService webhook idempotency (T10.1)", () => {
  const EVENT: SubscriptionEvent = {
    eventId: "evt_1",
    userId: "user-1",
    providerCustomerId: "cus_1",
    providerSubscriptionId: "sub_1",
    plan: "pro",
    status: "active",
    currentPeriodEnd: null,
  };

  function makeService(client: FakeSupabaseClient): BillingService {
    const provider = {
      handleWebhook: vi.fn(async () => EVENT),
    } as unknown as PaymentProvider;
    const supabase = { getServiceClient: () => client } as unknown as SupabaseService;
    return new BillingService(supabase, provider);
  }

  it("applies a fresh event to the subscriptions table", async () => {
    const client = new FakeSupabaseClient()
      .queue("processed_webhook_events", [{ error: null }])
      .queue("subscriptions", [{ error: null }]);
    const service = makeService(client);

    const result = await service.handleStripeWebhook(Buffer.from("{}"), "sig");
    expect(result).toEqual({ received: true });
    const upsert = client.calls.find((c) => c.table === "subscriptions" && c.method === "upsert");
    expect(upsert?.payload).toMatchObject({
      user_id: "user-1",
      provider: "stripe",
      plan: "pro",
      status: "active",
      provider_subscription_id: "sub_1",
    });
  });

  it("a replayed event (duplicate id) is a no-op", async () => {
    const client = new FakeSupabaseClient().queue("processed_webhook_events", [
      { error: { message: "duplicate key value", code: "23505" } },
    ]);
    const service = makeService(client);

    const result = await service.handleStripeWebhook(Buffer.from("{}"), "sig");
    expect(result).toEqual({ received: true, duplicate: true });
    // subscriptions was never touched
    expect(client.calls.find((c) => c.table === "subscriptions")).toBeUndefined();
  });

  it("resolves the user via provider_subscription_id when the event has no user ref", async () => {
    const client = new FakeSupabaseClient()
      .queue("processed_webhook_events", [{ error: null }])
      .queue("subscriptions", [{ data: { user_id: "user-9" } }, { error: null }]);
    const provider = {
      handleWebhook: vi.fn(async () => ({ ...EVENT, userId: null })),
    } as unknown as PaymentProvider;
    const supabase = { getServiceClient: () => client } as unknown as SupabaseService;
    const service = new BillingService(supabase, provider);

    await service.handleStripeWebhook(Buffer.from("{}"), "sig");
    const upsert = client.calls.find((c) => c.table === "subscriptions" && c.method === "upsert");
    expect(upsert?.payload).toMatchObject({ user_id: "user-9" });
  });
});
