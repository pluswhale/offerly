"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AiMessage, Profile, UsageSummary } from "@offerly/types";
import { api, PaywallError } from "@/lib/api";
import { streamCoachMessage } from "@/lib/coach-stream";
import { useApi } from "@/lib/use-api";
import type { CoachConversation } from "@/lib/contract";
import { Button } from "@/components/button";
import { Card, CardBody } from "@/components/card";
import { CvSelector } from "@/components/cv-selector";
import { ProgressiveProfilePrompt } from "@/components/progressive-profile-prompt";
import { Skeleton } from "@/components/skeleton";
import { UpgradeButton } from "@/components/upgrade-button";

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system-summary";
  content: string;
}

const SUGGESTIONS = [
  { label: "Improve my CV", href: "/cv" },
  { label: "Run a Job Match", href: "/match" },
  { label: "Review my pipeline", href: "/tracker" },
] as const;

export function CoachClient() {
  const { data: usage, loading: usageLoading } = useApi<UsageSummary>(() =>
    api<UsageSummary>("/usage/me"),
  );
  const { data: profile } = useApi<Profile>(() => api<Profile>("/profiles/me"));

  const [conversation, setConversation] = useState<CoachConversation | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const idCounter = useRef(0);
  const ensureRef = useRef<Promise<CoachConversation> | null>(null);

  const nextId = () => `local-${++idCounter.current}`;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  // Resume the ongoing conversation on load so previous history is visible
  // before the first message is sent.
  useEffect(() => {
    ensureConversation().catch((err) => {
      if (err instanceof PaywallError) setLocked(true);
      // Other errors: conversation will be retried on first send.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ensureConversation(): Promise<CoachConversation> {
    if (conversation) return Promise.resolve(conversation);
    // Share one in-flight attempt so the mount effect and an early send
    // can't create two conversations.
    ensureRef.current ??= (async () => {
      const created = await api<CoachConversation>("/coach/conversations", {
        method: "POST",
        json: { kind: "coach" },
      });
      setConversation(created);
      // Load history if the conversation already has messages (e.g. resumed).
      try {
        const history = await api<AiMessage[]>(
          `/coach/conversations/${created.id}/messages`,
        );
        setMessages(
          history.map((m) => ({ id: m.id, role: m.role, content: m.content })),
        );
      } catch {
        // History endpoint may not exist yet — a fresh conversation is fine.
      }
      return created;
    })();
    // Allow a retry on the next send if this attempt failed.
    ensureRef.current.catch(() => {
      ensureRef.current = null;
    });
    return ensureRef.current;
  }

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const content = input.trim();
    if (!content || streaming) return;
    setInput("");
    setError(null);

    let convo: CoachConversation;
    try {
      convo = await ensureConversation();
    } catch (err) {
      if (err instanceof PaywallError) setLocked(true);
      else setError(err instanceof Error ? err.message : "Couldn't start the coach");
      return;
    }

    const userMsg: ChatMessage = { id: nextId(), role: "user", content };
    const assistantMsg: ChatMessage = { id: nextId(), role: "assistant", content: "" };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStreaming(true);

    await streamCoachMessage(
      convo.id,
      content,
      {
        onEvent: (event) => {
          if (event.type === "token") {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantMsg.id
                  ? { ...m, content: m.content + event.content }
                  : m,
              ),
            );
          } else if (event.type === "notice") {
            // Context compaction notice (spec §5.6) — rendered as a system bubble.
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: "system-summary", content: event.content },
            ]);
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        onError: (message) => setError(message),
      },
    );
    setStreaming(false);
  }

  if (usageLoading) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading coach">
        <Skeleton className="h-9 w-40" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  // Free tier: locked preview with one example interaction (spec §5.6).
  if (locked || usage?.plan === "free") {
    return <LockedPreview />;
  }

  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col gap-4 md:h-[calc(100vh-6rem)]">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">AI Coach</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Career guidance grounded in your CV, target role, and pipeline.
        </p>
      </div>

      {/* The coach reads the active CV server-side on every message. */}
      <CvSelector />

      <ProgressiveProfilePrompt
        profile={profile}
        field="experience_level"
        reason="The coach calibrates its advice to your seniority."
      />

      {/* Suggestion chips deep-link into features (T9.2) */}
      <div className="flex flex-wrap gap-2" aria-label="Quick actions">
        {SUGGESTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="inline-flex min-h-11 items-center rounded-full border border-neutral-300 bg-white px-4 text-sm font-medium text-neutral-700 hover:border-accent-400 hover:text-accent-700"
          >
            {s.label}
          </Link>
        ))}
      </div>

      <Card className="flex min-h-0 flex-1 flex-col">
        <CardBody className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <p className="text-sm font-medium text-neutral-900">Ask me anything about your search</p>
              <p className="max-w-sm text-sm text-neutral-500">
                Interview prep, salary negotiation, which jobs to prioritize — I know your CV
                and pipeline, so answers are specific to you.
              </p>
            </div>
          ) : (
            messages.map((m) =>
              m.role === "system-summary" ? (
                <p
                  key={m.id}
                  role="note"
                  className="mx-auto rounded-lg bg-neutral-100 px-3 py-2 text-center text-xs text-neutral-500"
                >
                  {m.content}
                </p>
              ) : (
                <div
                  key={m.id}
                  className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    m.role === "user"
                      ? "self-end bg-accent-600 text-white"
                      : "self-start bg-neutral-100 text-neutral-900"
                  }`}
                >
                  {m.content ||
                    (m.role === "assistant" && streaming ? (
                      <span className="inline-flex items-center gap-1 text-neutral-400">
                        <span className="size-1.5 animate-bounce rounded-full bg-current" />
                        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:150ms]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:300ms]" />
                      </span>
                    ) : null)}
                </div>
              ),
            )
          )}
          <div ref={bottomRef} />
        </CardBody>

        <form onSubmit={send} className="flex gap-2 border-t border-neutral-100 p-3">
          <label htmlFor="coach-input" className="sr-only">
            Message the coach
          </label>
          <input
            id="coach-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask about interviews, salary, strategy…"
            disabled={streaming}
            className="min-h-11 flex-1 rounded-lg border border-neutral-300 bg-white px-3 text-sm disabled:bg-neutral-50"
          />
          <Button type="submit" disabled={!input.trim() || streaming}>
            Send
          </Button>
        </form>
      </Card>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

function LockedPreview() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-neutral-900">AI Coach</h1>
        <p className="mt-1 text-sm text-neutral-500">
          Career guidance grounded in your CV, target role, and pipeline.
        </p>
      </div>

      <Card>
        <CardBody className="flex flex-col gap-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
            Example
          </p>
          <div className="max-w-[85%] self-end rounded-2xl bg-accent-600 px-4 py-2.5 text-sm text-white">
            I have an interview for the Acme frontend role next week. What should I prepare?
          </div>
          <div className="max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-2.5 text-sm text-neutral-900">
            Based on your CV and the Acme job description: expect questions on React
            performance (your strongest signal) and accessibility (a gap vs. their
            requirements). I&apos;d prepare a story about the design-system migration on
            page 1 of your CV, and skim ARIA basics before Thursday…
          </div>
        </CardBody>
      </Card>

      <Card className="border-accent-200 bg-accent-50/50">
        <CardBody className="flex flex-col items-start gap-3">
          <p className="text-lg font-semibold text-neutral-900">
            The coach is a Pro feature
          </p>
          <p className="max-w-md text-sm text-neutral-600">
            Upgrade to have a coach that knows your actual CV, target role, and every
            application in your tracker — available whenever you need it.
          </p>
          <UpgradeButton />
        </CardBody>
      </Card>
    </div>
  );
}
