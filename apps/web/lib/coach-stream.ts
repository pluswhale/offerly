"use client";

import type { CoachStreamEvent } from "./contract";
import { createClient } from "./supabase/client";

export interface CoachStreamHandlers {
  onEvent: (event: CoachStreamEvent) => void;
  onError: (message: string) => void;
}

/**
 * Consumes the coach SSE stream (T9.2): POST + ReadableStream, parsing
 * `event:`/`data:` frames. No EventSource because the endpoint is POST
 * with a bearer token.
 */
export async function streamCoachMessage(
  conversationId: string,
  content: string,
  handlers: CoachStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const base = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
  const res = await fetch(
    `${base}/api/v1/coach/conversations/${conversationId}/messages`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        ...(session?.access_token
          ? { Authorization: `Bearer ${session.access_token}` }
          : {}),
      },
      body: JSON.stringify({ content }),
      signal,
    },
  );

  if (!res.ok || !res.body) {
    handlers.onError(`Request failed with status ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      let eventType = "message";
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const raw = dataLines.join("\n");
      if (!raw) continue;
      try {
        const data = JSON.parse(raw) as Record<string, unknown>;
        handlers.onEvent({ type: eventType, ...data } as CoachStreamEvent);
      } catch {
        // Plain-text chunk without JSON — treat as a token.
        handlers.onEvent({ type: "token", content: raw });
      }
    }
  }
}
