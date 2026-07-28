"use client";

import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import type { Profile, UpdateProfileRequest, UsageSummary } from "@offerly/types";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { PortalResponse } from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/input";
import { SkeletonCard } from "@/components/skeleton";
import { UpgradeButton } from "@/components/upgrade-button";
import { UsageMeter } from "@/components/usage-meter";

/**
 * Return from Stripe Checkout: /settings?success=1|canceled=1 (billing.module.ts).
 * Suspense-wrapped because useSearchParams opts out of prerendering.
 */
function CheckoutReturnBanner({ onSuccess }: { onSuccess: () => void }) {
  const params = useSearchParams();
  const [banner] = useState<"success" | "canceled" | null>(() =>
    params.get("success") ? "success" : params.get("canceled") ? "canceled" : null,
  );

  useEffect(() => {
    if (!banner) return;
    // Clean the URL so a refresh doesn't re-show the banner.
    window.history.replaceState(null, "", "/settings");
    if (banner !== "success") return;
    // The Stripe webhook flips the plan asynchronously — refetch once it landed.
    const timer = setTimeout(onSuccess, 2500);
    return () => clearTimeout(timer);
  }, [banner, onSuccess]);

  if (banner === "success") {
    return (
      <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
        Payment received — your plan upgrades to Pro as soon as Stripe confirms it (a few seconds).
      </p>
    );
  }
  if (banner === "canceled") {
    return (
      <p role="status" className="rounded-lg bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
        Checkout canceled — nothing was charged.
      </p>
    );
  }
  return null;
}

export function SettingsClient() {
  const { data: profile, error, loading, refetch } = useApi<Profile>(() =>
    api<Profile>("/profiles/me"),
  );
  const { data: usage, refetch: refetchUsage } = useApi<UsageSummary>(() =>
    api<UsageSummary>("/usage/me"),
  );

  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  async function openPortal() {
    setPortalLoading(true);
    setPortalError(null);
    try {
      const { url } = await api<PortalResponse>("/billing/portal", { method: "POST" });
      window.location.href = url;
    } catch {
      setPortalLoading(false);
      setPortalError("Couldn't open the billing portal");
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading settings">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <EmptyState
        title="Couldn't load settings"
        description={error ?? undefined}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Settings</h1>

      <Suspense fallback={null}>
        <CheckoutReturnBanner onSuccess={refetchUsage} />
      </Suspense>

      {/* Keyed so the form re-initializes from the fresh profile after save. */}
      <ProfileForm key={profile.updated_at} profile={profile} onSaved={refetch} />

      <Card>
        <CardHeader title="Billing" description="Manage your subscription." />
        <CardBody className="flex flex-col gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-700">Current plan:</span>
            <Badge tone={usage?.plan === "pro" ? "accent" : "neutral"}>
              {usage?.plan === "pro" ? "Pro" : "Free"}
            </Badge>
          </div>
          {usage && <UsageMeter usage={usage} />}
          {portalError && (
            <p role="alert" className="text-sm text-red-600">
              {portalError}
            </p>
          )}
          {usage?.plan === "pro" ? (
            <Button
              variant="secondary"
              onClick={openPortal}
              loading={portalLoading}
              className="self-start"
            >
              Manage subscription
            </Button>
          ) : (
            <UpgradeButton className="self-start" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function ProfileForm({
  profile,
  onSaved,
}: {
  profile: Profile;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    full_name: profile.full_name ?? "",
    current_role: profile.current_role ?? "",
    target_role: profile.target_role ?? "",
    experience_level: profile.experience_level ?? "",
    location: profile.location ?? "",
    visa_status: profile.visa_status ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function saveProfile(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      const json: UpdateProfileRequest = Object.fromEntries(
        Object.entries(form).map(([k, v]) => [k, v.trim() || undefined]),
      );
      await api<Profile>("/profiles/me", { method: "PATCH", json });
      setSaved(true);
      onSaved();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  const field = (
    key: keyof typeof form,
    label: string,
    placeholder: string,
  ) => (
    <Input
      label={label}
      value={form[key]}
      onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
      placeholder={placeholder}
    />
  );

  return (
    <Card>
      <CardHeader
        title="Profile"
        description="Used to personalize analyses and AI output. Fill fields in whenever — nothing here is required."
      />
      <CardBody>
        <form onSubmit={saveProfile} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            {field("full_name", "Full name", "Alex Smith")}
            {field("current_role", "Current role", "Frontend Developer")}
            {field("target_role", "Target role", "Senior Frontend Engineer")}
            {field("experience_level", "Experience level", "e.g. 3 years, mid-level")}
            {field("location", "Location", "e.g. Berlin, remote EU")}
            {field("visa_status", "Visa situation", "e.g. EU citizen, needs sponsorship")}
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" loading={saving}>
              Save profile
            </Button>
            {saved && (
              <span role="status" className="text-sm text-emerald-600">
                Saved ✓
              </span>
            )}
            {saveError && (
              <span role="alert" className="text-sm text-red-600">
                {saveError}
              </span>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
