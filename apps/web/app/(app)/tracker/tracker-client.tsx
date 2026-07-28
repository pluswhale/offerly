"use client";

import { useState, type DragEvent, type FormEvent } from "react";
import {
  APPLICATION_STATUSES,
  type Application,
  type ApplicationStatus,
  type CreateApplicationRequest,
  type UpdateApplicationRequest,
} from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { formatDate } from "@/lib/format";
import type { UpgradeRequiredPayload } from "@/lib/contract";
import { Badge } from "@/components/badge";
import { Button } from "@/components/button";
import { EmptyState } from "@/components/empty-state";
import { Input } from "@/components/input";
import { Modal } from "@/components/modal";
import { PaywallModal } from "@/components/paywall-modal";
import { Skeleton } from "@/components/skeleton";
import { StatusBadge } from "@/components/status-badge";
import { Textarea } from "@/components/textarea";

const STATUS_LABELS: Record<ApplicationStatus, string> = {
  saved: "Saved",
  applied: "Applied",
  interview: "Interview",
  offer: "Offer",
  rejected: "Rejected",
};

export function TrackerClient() {
  const [showArchived, setShowArchived] = useState(false);
  const { data, error, loading, refetch } = useApi<Application[]>(
    () => api<Application[]>(`/applications${showArchived ? "?archived=true" : ""}`),
    [showArchived],
  );

  // Local copy for optimistic updates; resynced on every successful fetch.
  const [local, setLocal] = useState<Application[] | null>(null);
  const applications = local ?? data ?? [];

  const [editing, setEditing] = useState<Application | "new" | null>(null);
  const [deleting, setDeleting] = useState<Application | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [paywall, setPaywall] = useState<UpgradeRequiredPayload | null>(null);

  function sync(next: Application[]) {
    setLocal(next);
  }

  /** Reload from the server into the local copy (no flicker back to stale data). */
  async function reload() {
    const fresh = await api<Application[]>(
      `/applications${showArchived ? "?archived=true" : ""}`,
    );
    setLocal(fresh);
  }

  /** Optimistic mutation: apply locally, persist, restore server state on failure. */
  async function mutate(
    optimistic: Application[],
    request: () => Promise<unknown>,
    failureMessage: string,
  ) {
    sync(optimistic);
    try {
      await request();
      await reload();
    } catch (err) {
      // Roll back to server truth; never lose data silently (spec §5.5).
      await reload().catch(() => setLocal(null));
      if (err instanceof PaywallError) setPaywall(err.payload);
      else setActionError(failureMessage);
    }
  }

  function changeStatus(app: Application, status: ApplicationStatus) {
    if (app.status === status) return;
    void mutate(
      applications.map((a) => (a.id === app.id ? { ...a, status } : a)),
      () =>
        api(`/applications/${app.id}`, {
          method: "PATCH",
          json: { status } satisfies UpdateApplicationRequest,
        }),
      "Couldn't update the status — change rolled back.",
    );
  }

  function toggleArchive(app: Application) {
    void mutate(
      applications.map((a) =>
        a.id === app.id ? { ...a, archived: !a.archived } : a,
      ),
      () =>
        api(`/applications/${app.id}`, {
          method: "PATCH",
          json: { archived: !app.archived } satisfies UpdateApplicationRequest,
        }),
      "Couldn't archive — change rolled back.",
    );
  }

  async function confirmDelete() {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    await mutate(
      applications.filter((a) => a.id !== target.id),
      () => api(`/applications/${target.id}`, { method: "DELETE" }),
      "Couldn't delete the entry — it was restored.",
    );
  }

  function onDragStart(e: DragEvent, id: string) {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  }

  function onDrop(e: DragEvent, status: ApplicationStatus) {
    e.preventDefault();
    const id = e.dataTransfer.getData("text/plain");
    const app = applications.find((a) => a.id === id);
    if (app) changeStatus(app, status);
  }

  const visible = applications.filter((a) => (showArchived ? true : !a.archived));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-neutral-900">Job Tracker</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Your pipeline at a glance — nothing falls through the cracks.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button size="sm" onClick={() => setEditing("new")}>
            Add job
          </Button>
        </div>
      </div>

      {actionError && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {actionError}
        </p>
      )}

      {loading ? (
        <div className="grid gap-3 md:grid-cols-5" aria-busy="true" aria-label="Loading tracker">
          {APPLICATION_STATUSES.map((s) => (
            <Skeleton key={s} className="h-48" />
          ))}
        </div>
      ) : error || !data ? (
        <EmptyState
          title="Couldn't load your tracker"
          description={error ?? undefined}
          action={<Button onClick={refetch}>Try again</Button>}
        />
      ) : visible.length === 0 ? (
        <EmptyState
          title={showArchived ? "Nothing here" : "No applications yet"}
          description="Add jobs you're considering or have applied to. Drag cards between columns as they move forward."
          action={<Button onClick={() => setEditing("new")}>Add your first job</Button>}
        />
      ) : (
        <>
          {/* Desktop kanban (native HTML5 DnD — no library, per constraints) */}
          <div className="hidden gap-3 md:grid md:grid-cols-5">
            {APPLICATION_STATUSES.map((status) => {
              const cards = visible.filter((a) => a.status === status);
              return (
                <section
                  key={status}
                  aria-label={`${STATUS_LABELS[status]} column`}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => onDrop(e, status)}
                  className="flex min-h-40 flex-col gap-2 rounded-xl bg-neutral-100/70 p-2"
                >
                  <header className="flex items-center justify-between px-1 pt-1">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                      {STATUS_LABELS[status]}
                    </h2>
                    <span className="text-xs tabular-nums text-neutral-400">{cards.length}</span>
                  </header>
                  {cards.map((app) => (
                    <TrackerCard
                      key={app.id}
                      app={app}
                      draggable
                      onDragStart={(e) => onDragStart(e, app.id)}
                      onClick={() => setEditing(app)}
                    />
                  ))}
                </section>
              );
            })}
          </div>

          {/* Mobile list with dropdown status change (DnD fallback) */}
          <ul className="flex flex-col gap-3 md:hidden">
            {visible.map((app) => (
              <li key={app.id} className="rounded-xl border border-neutral-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setEditing(app)}
                    className="min-w-0 flex-1 cursor-pointer text-left"
                  >
                    <p className="truncate text-sm font-semibold text-neutral-900">{app.role}</p>
                    <p className="truncate text-sm text-neutral-500">{app.company}</p>
                  </button>
                  <StatusBadge status={app.status} />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <label htmlFor={`status-${app.id}`} className="sr-only">
                    Status for {app.role} at {app.company}
                  </label>
                  <select
                    id={`status-${app.id}`}
                    value={app.status}
                    onChange={(e) => changeStatus(app, e.target.value as ApplicationStatus)}
                    className="min-h-11 flex-1 rounded-lg border border-neutral-300 bg-white px-3 text-sm"
                  >
                    {APPLICATION_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </option>
                    ))}
                  </select>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(app)}>
                    Edit
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {editing && (
        <ApplicationModal
          application={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setLocal(null);
            refetch();
          }}
          onArchive={(app) => {
            setEditing(null);
            toggleArchive(app);
          }}
          onDelete={(app) => {
            setEditing(null);
            setDeleting(app);
          }}
          onPaywall={(p) => setPaywall(p)}
        />
      )}

      <Modal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete application?"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-neutral-600">
            Delete <span className="font-medium">{deleting?.role} · {deleting?.company}</span>?
            {deleting?.job_id
              ? " Linked match and generated artifacts will be deleted with it."
              : ""}{" "}
            This can&apos;t be undone.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDelete}>
              Delete
            </Button>
          </div>
        </div>
      </Modal>

      <PaywallModal
        open={paywall !== null}
        onClose={() => setPaywall(null)}
        payload={paywall}
        attempted="Adding more applications"
      />
    </div>
  );
}

function TrackerCard({
  app,
  draggable,
  onDragStart,
  onClick,
}: {
  app: Application;
  draggable?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      draggable={draggable}
      onDragStart={onDragStart}
      onClick={onClick}
      aria-label={`${app.role} at ${app.company}, status ${STATUS_LABELS[app.status]}. Activate to edit.`}
      className="flex min-h-11 cursor-grab flex-col gap-1 rounded-lg border border-neutral-200 bg-white p-3 text-left shadow-[var(--shadow-card)] active:cursor-grabbing"
    >
      <p className="truncate text-sm font-semibold text-neutral-900">{app.role}</p>
      <p className="truncate text-xs text-neutral-500">{app.company}</p>
      <div className="mt-1 flex items-center gap-1.5">
        {app.job_id && <Badge tone="accent">Match linked</Badge>}
        {app.applied_at && (
          <span className="text-[11px] text-neutral-400">{formatDate(app.applied_at)}</span>
        )}
      </div>
    </button>
  );
}

function ApplicationModal({
  application,
  onClose,
  onSaved,
  onArchive,
  onDelete,
  onPaywall,
}: {
  application: Application | null;
  onClose: () => void;
  onSaved: () => void;
  onArchive: (app: Application) => void;
  onDelete: (app: Application) => void;
  onPaywall: (payload: UpgradeRequiredPayload) => void;
}) {
  const isNew = application === null;
  const [company, setCompany] = useState(application?.company ?? "");
  const [role, setRole] = useState(application?.role ?? "");
  const [status, setStatus] = useState<ApplicationStatus>(application?.status ?? "saved");
  const [appliedAt, setAppliedAt] = useState(application?.applied_at?.slice(0, 10) ?? "");
  const [notes, setNotes] = useState(application?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (isNew) {
        await api<Application>("/applications", {
          method: "POST",
          json: {
            company: company.trim(),
            role: role.trim(),
            status,
            applied_at: appliedAt || undefined,
            notes: notes.trim() || undefined,
          } satisfies CreateApplicationRequest,
        });
      } else {
        await api<Application>(`/applications/${application.id}`, {
          method: "PATCH",
          json: {
            company: company.trim(),
            role: role.trim(),
            status,
            applied_at: appliedAt || null,
            notes: notes.trim() || null,
          } satisfies UpdateApplicationRequest,
        });
      }
      onSaved();
    } catch (err) {
      if (err instanceof PaywallError) {
        onClose();
        onPaywall(err.payload);
      } else {
        setError(err instanceof Error ? err.message : "Could not save");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={isNew ? "Add application" : "Edit application"}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Input
          label="Company"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          required
        />
        <Input
          label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          required
        />
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="app-status" className="text-sm font-medium text-neutral-700">
              Status
            </label>
            <select
              id="app-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as ApplicationStatus)}
              className="min-h-11 rounded-lg border border-neutral-300 bg-white px-3 text-sm"
            >
              {APPLICATION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <Input
            label="Date applied"
            type="date"
            value={appliedAt}
            onChange={(e) => setAppliedAt(e.target.value)}
          />
        </div>
        <Textarea
          label="Notes"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Contacts, follow-ups, interview prep…"
        />
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          {!isNew ? (
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => onArchive(application)}>
                {application.archived ? "Unarchive" : "Archive"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => onDelete(application)}>
                Delete
              </Button>
            </div>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!company.trim() || !role.trim()}>
              {isNew ? "Add" : "Save"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
