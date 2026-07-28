"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import type { CheckoutResponse } from "@/lib/contract";
import { Button } from "./button";

/** Starts a Stripe checkout session and redirects (POST /billing/checkout). */
export function UpgradeButton({
  children = "Upgrade to Pro",
  className = "",
}: {
  children?: React.ReactNode;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setLoading(true);
    setError(null);
    try {
      const { url } = await api<CheckoutResponse>("/billing/checkout", {
        method: "POST",
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start checkout");
      setLoading(false);
    }
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <Button onClick={onClick} loading={loading} className={className}>
        {children}
      </Button>
      {error && (
        <span role="alert" className="text-sm text-red-600">
          {error}
        </span>
      )}
    </span>
  );
}
