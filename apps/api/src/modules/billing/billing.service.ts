import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { env } from "../../common/env.js";
import { SupabaseService } from "../supabase/supabase.service.js";
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type SubscriptionEvent,
} from "./payment-provider.js";

/**
 * Billing writes (T10.1): the webhook handler is the ONLY writer of the
 * subscriptions table (constitution §III) — via the service-role client.
 */
@Injectable()
export class BillingService {
  constructor(
    private readonly supabase: SupabaseService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  async createCheckout(userId: string, token: string, priceId?: string): Promise<{ url: string }> {
    const price = priceId ?? env("STRIPE_PRICE_ID", "");
    if (!price) throw new BadRequestException("No price configured");
    const db = this.supabase.forUser(token);
    const { data: sub } = await db
      .from("subscriptions")
      .select("provider_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    return this.provider.createCheckoutSession(
      userId,
      price,
      (sub as { provider_customer_id: string | null } | null)?.provider_customer_id,
    );
  }

  async createPortal(userId: string, token: string): Promise<{ url: string }> {
    const db = this.supabase.forUser(token);
    const { data: sub } = await db
      .from("subscriptions")
      .select("provider_customer_id")
      .eq("user_id", userId)
      .maybeSingle();
    const customerId = (sub as { provider_customer_id: string | null } | null)
      ?.provider_customer_id;
    if (!customerId) {
      throw new BadRequestException("No billing account yet — start a subscription first");
    }
    return this.provider.createPortalSession(customerId);
  }

  /**
   * Webhook processing: signature was already verified by the provider.
   * Idempotent via event-id check (T10.2 acceptance): a replayed event is a no-op.
   */
  async handleStripeWebhook(
    payload: Buffer,
    signature: string,
  ): Promise<{ received: true; duplicate?: boolean; ignored?: boolean }> {
    const event = await this.provider.handleWebhook(payload, signature);
    const db = this.supabase.getServiceClient();

    const { error: insertError } = await db
      .from("processed_webhook_events")
      .insert({ event_id: event.eventId });
    if (insertError) {
      // Postgres unique-violation → this event was already processed.
      if (insertError.code === "23505") return { received: true, duplicate: true };
      throw new Error(`Failed to record webhook event: ${insertError.message}`);
    }

    if ("ignored" in event) return { received: true, ignored: true };
    await this.applyEvent(event);
    return { received: true };
  }

  private async applyEvent(event: SubscriptionEvent): Promise<void> {
    const db = this.supabase.getServiceClient();
    let userId = event.userId;
    if (!userId && event.providerSubscriptionId) {
      const { data } = await db
        .from("subscriptions")
        .select("user_id")
        .eq("provider_subscription_id", event.providerSubscriptionId)
        .maybeSingle();
      userId = (data as { user_id: string } | null)?.user_id ?? null;
    }
    if (!userId) return; // unresolvable — recorded, nothing to apply

    const { error } = await db.from("subscriptions").upsert(
      {
        user_id: userId,
        provider: "stripe",
        provider_customer_id: event.providerCustomerId,
        provider_subscription_id: event.providerSubscriptionId,
        plan: event.plan,
        status: event.status,
        current_period_end: event.currentPeriodEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) throw new Error(`Failed to update subscription: ${error.message}`);
  }
}
