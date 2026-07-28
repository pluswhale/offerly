"use client";

import type { UpgradeRequiredPayload } from "@/lib/contract";
import { Modal } from "./modal";
import { UpgradeButton } from "./upgrade-button";

/**
 * Contextual paywall (T10.3): shown wherever the API returns 402. Displays
 * what the user attempted plus an upgrade CTA (spec §3 journey 4).
 */
export function PaywallModal({
  open,
  onClose,
  payload,
  attempted,
}: {
  open: boolean;
  onClose: () => void;
  payload: UpgradeRequiredPayload | null;
  /** Plain-English description of what the user tried to do. */
  attempted: string;
}) {
  return (
    <Modal open={open} onClose={onClose} title="Upgrade to Pro">
      <div className="flex flex-col gap-4">
        <p className="text-sm text-neutral-700">
          <span className="font-medium">{attempted}</span>{" "}
          {payload?.message ?? "is a Pro feature or exceeds your free plan limit."}
        </p>
        {payload?.limit !== undefined && payload?.used !== undefined && (
          <p className="rounded-lg bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
            You&apos;ve used {payload.used} of {payload.limit} included this month.
          </p>
        )}
        <ul className="flex flex-col gap-2 text-sm text-neutral-700">
          <li>✓ Unlimited CV analyses and job matches</li>
          <li>✓ Full AI Apply Assistant — letters, answers, regeneration</li>
          <li>✓ AI Coach that knows your CV and pipeline</li>
          <li>✓ Unlimited tracked applications</li>
        </ul>
        <div className="flex items-center gap-3">
          <UpgradeButton className="flex-1" />
          <a
            href="/pricing"
            className="flex min-h-11 items-center rounded-lg px-3 text-sm font-medium text-neutral-600 hover:bg-neutral-100"
          >
            Compare plans
          </a>
        </div>
      </div>
    </Modal>
  );
}
