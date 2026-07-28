"use client";

import Link from "next/link";
import {
  APPLICATION_STATUSES,
  type Application,
  type Cv,
  type UsageSummary,
} from "@offerly/types";
import { api } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { nextBestAction } from "@/lib/next-action";
import { formatRelative } from "@/lib/format";
import { Card, CardBody, CardHeader } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Skeleton, SkeletonCard } from "@/components/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { UsageMeter } from "@/components/usage-meter";
import { Button } from "@/components/button";

interface DashboardData {
  cvs: Cv[];
  applications: Application[];
  usage: UsageSummary | null;
}

export function DashboardClient() {
  const { data, error, loading, refetch } = useApi<DashboardData>(async () => {
    // Usage is a UX hint; it must not block the dashboard if it fails.
    const [cvs, applications, usage] = await Promise.all([
      api<Cv[]>("/cvs"),
      api<Application[]>("/applications"),
      api<UsageSummary>("/usage/me").catch(() => null),
    ]);
    return { cvs, applications, usage };
  });

  if (loading) {
    return (
      <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading dashboard">
        <Skeleton className="h-9 w-48" />
        <SkeletonCard />
        <div className="grid gap-4 md:grid-cols-2">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <EmptyState
        title="Couldn't load your dashboard"
        description={error ?? undefined}
        action={<Button onClick={refetch}>Try again</Button>}
      />
    );
  }

  const { cvs, applications, usage } = data;
  const active = applications.filter((a) => !a.archived);
  const action = nextBestAction({ cvs, applications });
  const counts = new Map(
    APPLICATION_STATUSES.map(
      (s) => [s, active.filter((a) => a.status === s).length] as const,
    ),
  );
  const recent = [...applications]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Dashboard</h1>

      {/* Next best action */}
      <Card className="border-accent-200 bg-accent-50/50">
        <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-accent-700">
              Next best action
            </p>
            <p className="mt-1 text-lg font-semibold text-neutral-900">{action.title}</p>
            <p className="mt-0.5 text-sm text-neutral-600">{action.description}</p>
          </div>
          <Link
            href={action.href}
            className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white shadow-sm hover:bg-accent-700"
          >
            {action.cta}
          </Link>
        </CardBody>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Pipeline summary */}
        <Card>
          <CardHeader
            title="Pipeline"
            description={`${active.length} active application${active.length === 1 ? "" : "s"}`}
            action={
              <Link href="/tracker" className="text-sm font-medium text-accent-600 hover:text-accent-700">
                View all
              </Link>
            }
          />
          <CardBody>
            {active.length === 0 ? (
              <EmptyState
                title="No applications yet"
                description="Track every job you apply to so nothing falls through the cracks."
                action={
                  <Link
                    href="/tracker"
                    className="inline-flex min-h-11 items-center rounded-lg bg-accent-600 px-4 text-sm font-medium text-white hover:bg-accent-700"
                  >
                    Add your first job
                  </Link>
                }
              />
            ) : (
              <ul className="flex flex-col gap-2">
                {APPLICATION_STATUSES.map((s) => (
                  <li key={s} className="flex items-center justify-between gap-3">
                    <StatusBadge status={s} />
                    <span className="text-sm font-semibold tabular-nums text-neutral-900">
                      {counts.get(s) ?? 0}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        {/* Usage */}
        <Card>
          <CardHeader title="Usage" description="Your AI quota resets monthly." />
          <CardBody className="flex flex-col gap-4">
            {usage ? (
              <>
                <UsageMeter usage={usage} />
                {usage.plan === "free" && (
                  <Link
                    href="/pricing"
                    className="text-sm font-medium text-accent-600 hover:text-accent-700"
                  >
                    Upgrade for unlimited AI →
                  </Link>
                )}
              </>
            ) : (
              <p className="text-sm text-neutral-500">
                Usage information is unavailable right now.
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Recent activity */}
      <Card>
        <CardHeader title="Recent activity" />
        <CardBody>
          {recent.length === 0 ? (
            <p className="text-sm text-neutral-500">
              Nothing here yet — your latest tracker updates will show up here.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-neutral-100">
              {recent.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-neutral-900">
                      {a.role} · {a.company}
                    </p>
                    <p className="text-xs text-neutral-500">{formatRelative(a.updated_at)}</p>
                  </div>
                  <StatusBadge status={a.status} />
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
