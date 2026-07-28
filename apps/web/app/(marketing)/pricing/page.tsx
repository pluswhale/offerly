import Link from "next/link";
import { PLAN_LIMITS } from "@offerly/types";
import type { Metadata } from "next";
import { Card, CardBody } from "@/components/card";
import { UpgradeButton } from "@/components/upgrade-button";

export const metadata: Metadata = {
  title: "Pricing — Offerly",
  description: "Free to start. Pro for unlimited AI career tools.",
};

const FREE_FEATURES = [
  `${PLAN_LIMITS.free.aiRequestsPerMonth} AI requests per month`,
  `${PLAN_LIMITS.free.cvAnalyses} basic CV analysis (1 version)`,
  `Up to ${PLAN_LIMITS.free.activeApplications} tracked applications`,
  "1 sample Apply Assistant generation",
  "Full dashboard",
] as const;

const PRO_FEATURES = [
  "Unlimited CV analyses & versions, deep analysis",
  "Unlimited Job Match with deep gap analysis",
  "Full AI Apply Assistant with regeneration",
  "Unlimited tracked applications",
  "AI Coach that knows your CV and pipeline",
] as const;

export default function PricingPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-16 md:py-24">
      <div className="mb-12 flex flex-col items-center gap-3 text-center">
        <h1 className="text-3xl font-bold tracking-tight text-neutral-900 md:text-4xl">
          Simple pricing
        </h1>
        <p className="max-w-lg text-neutral-600">
          Start free. Upgrade when you want unlimited AI firepower for your search.
        </p>
      </div>

      <div className="mx-auto grid max-w-3xl gap-6 md:grid-cols-2">
        {/* Free */}
        <Card>
          <CardBody className="flex h-full flex-col gap-5 p-6">
            <div>
              <h2 className="text-lg font-semibold text-neutral-900">Free</h2>
              <p className="mt-1 text-3xl font-bold text-neutral-900">
                $0<span className="text-base font-normal text-neutral-500"> / forever</span>
              </p>
            </div>
            <ul className="flex flex-1 flex-col gap-2.5">
              {FREE_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-neutral-700">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              href="/signup"
              className="inline-flex min-h-11 items-center justify-center rounded-lg border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-800 hover:bg-neutral-50"
            >
              Get started free
            </Link>
          </CardBody>
        </Card>

        {/* Pro */}
        <Card className="border-accent-600 ring-1 ring-accent-600">
          <CardBody className="flex h-full flex-col gap-5 p-6">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-neutral-900">Pro</h2>
                <span className="rounded-full bg-accent-50 px-2.5 py-0.5 text-xs font-medium text-accent-700">
                  Recommended
                </span>
              </div>
              <p className="mt-1 text-3xl font-bold text-neutral-900">
                $12<span className="text-base font-normal text-neutral-500"> / month</span>
              </p>
            </div>
            <ul className="flex flex-1 flex-col gap-2.5">
              {PRO_FEATURES.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-neutral-700">
                  <Check />
                  {f}
                </li>
              ))}
            </ul>
            {/* Starts Stripe checkout when logged in; otherwise the API 401
                redirects to login, which then continues to upgrade. */}
            <UpgradeButton className="w-full">Upgrade to Pro</UpgradeButton>
          </CardBody>
        </Card>
      </div>
    </main>
  );
}

function Check() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="mt-0.5 shrink-0 text-accent-600"
    >
      <path
        d="M3 8.5 6.5 12 13 4.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
