import { HttpException } from "@nestjs/common";

/** 402 with upgrade payload (T10.2) — free-tier limit hit or locked feature. */
export class PaymentRequiredException extends HttpException {
  constructor(feature: string, reason: string) {
    super(
      {
        statusCode: 402,
        error: "Payment Required",
        message: reason,
        feature,
        upgrade: { plan: "pro", url: "/settings/billing" },
      },
      402,
    );
  }
}
