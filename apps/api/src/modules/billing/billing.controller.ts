import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Post,
  Req,
} from "@nestjs/common";
import type { Request } from "express";
import { IsOptional, IsString } from "class-validator";
import { AccessToken, UserId } from "../auth/current-user.decorator.js";
import { Public } from "../auth/public.decorator.js";
import { BillingService } from "./billing.service.js";

class CreateCheckoutDto {
  @IsOptional()
  @IsString()
  price_id?: string;
}

@Controller("billing")
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @Post("checkout")
  checkout(
    @UserId() userId: string,
    @AccessToken() token: string,
    @Body() dto: CreateCheckoutDto,
  ): Promise<{ url: string }> {
    return this.billing.createCheckout(userId, token, dto.price_id);
  }

  @Post("portal")
  portal(
    @UserId() userId: string,
    @AccessToken() token: string,
  ): Promise<{ url: string }> {
    return this.billing.createPortal(userId, token);
  }
}

/**
 * Stripe webhook (T10.1): public route, raw body required for signature
 * verification. AuthGuard skips this via @Public().
 */
@Controller("billing/webhooks")
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Public()
  @Post("stripe")
  handleStripe(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers("stripe-signature") signature: string | undefined,
  ): Promise<{ received: true; duplicate?: boolean; ignored?: boolean }> {
    if (!signature) throw new BadRequestException("Missing stripe-signature header");
    if (!req.rawBody) throw new BadRequestException("Raw body unavailable");
    return this.billing.handleStripeWebhook(req.rawBody, signature);
  }
}
