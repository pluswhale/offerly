import type { Request } from "express";

/** Request shape after AuthGuard ran: userId + bearer token are attached. */
export interface AuthenticatedRequest extends Request {
  userId: string;
  accessToken: string;
}
