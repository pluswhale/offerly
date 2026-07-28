import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-10 text-center">
      {icon && (
        <div className="flex size-11 items-center justify-center rounded-full bg-accent-50 text-accent-600" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-base font-medium text-neutral-900">{title}</p>
      {description && <p className="max-w-sm text-sm text-neutral-500">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
