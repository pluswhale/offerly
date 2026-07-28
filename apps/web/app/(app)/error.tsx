"use client";

import { Button } from "@/components/button";

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-lg font-semibold text-neutral-900">Something went wrong</p>
      <p className="max-w-md text-sm text-neutral-500">{error.message}</p>
      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
