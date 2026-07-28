import type { UpgradeRequiredPayload } from "./contract";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** 402 — quota exhausted or Pro-only feature. Carries the upgrade payload. */
export class PaywallError extends ApiError {
  constructor(public payload: UpgradeRequiredPayload) {
    super(402, payload.message ?? "Upgrade required", payload);
    this.name = "PaywallError";
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  /** JSON body. */
  json?: unknown;
  /** Raw body for non-JSON requests (rare; signed uploads go to Storage directly). */
  signal?: AbortSignal;
}

const API_PREFIX = "/api/v1";

function baseUrl(): string {
  return process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
}

async function parseError(res: Response): Promise<never> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.status === 402) {
    throw new PaywallError(
      (body as UpgradeRequiredPayload) ?? { error: "upgrade_required" },
    );
  }
  const message =
    (body as { message?: string } | undefined)?.message ??
    `Request failed with status ${res.status}`;
  throw new ApiError(res.status, message, body);
}

/**
 * Typed API request with a pre-resolved bearer token. Shared core for the
 * browser and server clients. `onUnauthorized` decides 401 behavior.
 */
export async function request<T>(
  path: string,
  token: string | null,
  options: RequestOptions = {},
  onUnauthorized?: () => void,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.json !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${baseUrl()}${API_PREFIX}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
    signal: options.signal,
  });

  if (res.status === 401) {
    onUnauthorized?.();
    throw new ApiError(401, "Unauthorized");
  }
  if (!res.ok) return parseError(res);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
