import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "isPublic";

/** Marks a route as skipping the global AuthGuard (health, Stripe webhooks). */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
