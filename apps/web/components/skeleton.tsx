export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded-lg bg-neutral-200/70 ${className}`}
    />
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-5" aria-hidden="true">
      <Skeleton className="mb-3 h-5 w-1/3" />
      <Skeleton className="mb-2 h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
    </div>
  );
}
