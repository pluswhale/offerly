import { Module } from "@nestjs/common";
import Stripe from "stripe";
import { env } from "../../common/env.js";
import { BillingController, StripeWebhookController } from "./billing.controller.js";
import { BillingService } from "./billing.service.js";
import { PAYMENT_PROVIDER, type PaymentProvider } from "./payment-provider.js";
import { StripePaymentProvider } from "./stripe-payment.provider.js";

@Module({
  controllers: [BillingController, StripeWebhookController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      useFactory: (): PaymentProvider =>
        new StripePaymentProvider(
          new Stripe(env("STRIPE_SECRET_KEY", "sk_test_placeholder")),
          env("STRIPE_WEBHOOK_SECRET", ""),
          {
            successUrl: `${env("WEB_URL", "http://localhost:3000")}/settings?success=1`,
            cancelUrl: `${env("WEB_URL", "http://localhost:3000")}/settings?canceled=1`,
            portalReturnUrl: `${env("WEB_URL", "http://localhost:3000")}/settings`,
          },
        ),
    },
    BillingService,
  ],
})
export class BillingModule {}
