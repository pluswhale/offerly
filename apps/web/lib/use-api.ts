"use client";

import { useCallback, useEffect, useState } from "react";

export interface ApiState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  refetch: () => void;
}

/**
 * Minimal data-fetching hook: loading / error / data + refetch.
 * Not a state library — just the three states every fetch needs (spec §7).
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: readonly unknown[] = [],
): ApiState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    // Reset state in a microtask: synchronous setState in an effect body
    // causes cascading renders (react-hooks/set-state-in-effect).
    queueMicrotask(() => {
      if (!cancelled) {
        setLoading(true);
        setError(null);
      }
    });
    fetcher()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Something went wrong");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps + tick are the caller's re-fetch triggers
  }, [tick, ...deps]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  return { data, error, loading, refetch };
}
