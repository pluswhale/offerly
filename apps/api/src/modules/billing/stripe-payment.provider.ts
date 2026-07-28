import { BadRequestException } from "@nestjs/common";
import type { SubscriptionStatus } from "@offerly/types";
import type Stripe from "stripe";
import type { PaymentProvider, WebhookEvent } from "./payment-provider.js";

/**
 * Stripe implementation (T10.1). The Stripe client is injected so tests can
 * pass a mock — signature verification and event mapping run without network.
 */
export class StripePaymentProvider implements PaymentProvider {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecret: string,
    private readonly urls: { successUrl: string; cancelUrl: string; portalReturnUrl: string },
  ) {}

  async createCheckoutSession(
    userId: string,
    priceId: string,
    customerId?: string | null,
  ): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: userId,
      metadata: { user_id: userId },
      subscription_data: { metadata: { user_id: userId } },
      ...(customerId ? { customer: customerId } : {}),
      success_url: this.urls.successUrl,
      cancel_url: this.urls.cancelUrl,
    });
    if (!session.url) throw new Error("Stripe did not return a checkout URL");
    return { url: session.url };
  }

  async createPortalSession(customerId: string): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: this.urls.portalReturnUrl,
    });
    return { url: session.url };
  }

  /** Signature verification is mandatory (constitution §III). */
  async handleWebhook(payload: Buffer, signature: string): Promise<WebhookEvent> {
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(payload, signature, this.webhookSecret);
    } catch (err) {
      throw new BadRequestException(
        `Invalid webhook signature: ${err instanceof Error ? err.message : "verification failed"}`,
      );
    }
    return this.toSubscriptionEvent(event);
  }

  private toSubscriptionEvent(event: Stripe.Event): WebhookEvent {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        return {
          eventId: event.id,
          userId: session.client_reference_id ?? session.metadata?.user_id ?? null,
          providerCustomerId: (session.customer as string | null) ?? null,
          providerSubscriptionId: (session.subscription as string | null) ?? null,
          plan: "pro",
          status: "active",
          currentPeriodEnd: null, // filled in by customer.subscription.updated
        };
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        const deleted = event.type === "customer.subscription.deleted";
        const status = (deleted ? "canceled" : sub.status) as SubscriptionStatus;
        // Newer Stripe API versions nest the period end on subscription items.
        const periodEnd =
          sub.items?.data?.[0]?.current_period_end ??
          (sub as unknown as { current_period_end?: number }).current_period_end ??
          null;
        return {
          eventId: event.id,
          userId: sub.metadata?.user_id ?? null,
          providerCustomerId: (sub.customer as string | null) ?? null,
          providerSubscriptionId: sub.id,
          plan: deleted || status === "canceled" ? "free" : "pro",
          status,
          currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        };
      }
      default:
        // Acknowledge events we don't act on (invoice.paid, customer.created…)
        // with 200 so Stripe doesn't retry them (plan §3: ignored flag).
        return { eventId: event.id, ignored: true };
    }
  }
}
