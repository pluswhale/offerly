import type { SubscriptionStatus } from "@offerly/types";

/**
 * Payment provider abstraction (plan §7, T10.1). MVP implements Stripe only;
 * a crypto provider is a second implementation of this interface later.
 */
export interface PaymentProvider {
  createCheckoutSession(
    userId: string,
    priceId: string,
    customerId?: string | null,
  ): Promise<{ url: string }>;
  createPortalSession(customerId: string): Promise<{ url: string }>;
  /** Verifies the signature (throws on failure) and normalizes the event.
   *  Unhandled event types return `{ ignored: true }` so the webhook
   *  acknowledges them with 200 instead of triggering Stripe retries. */
  handleWebhook(payload: Buffer, signature: string): Promise<WebhookEvent>;
}

/** Normalized provider event; `ignored` = valid signature, event type we don't act on. */
export type WebhookEvent = SubscriptionEvent | { eventId: string; ignored: true };

export interface SubscriptionEvent {
  eventId: string;
  /** Null when the event carries no user reference (resolved by the service). */
  userId: string | null;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
  plan: "free" | "pro";
  status: SubscriptionStatus;
  currentPeriodEnd: string | null;
}

export const PAYMENT_PROVIDER = Symbol("PAYMENT_PROVIDER");
