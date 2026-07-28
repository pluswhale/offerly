import { forwardRef, type ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm";

const variants: Record<Variant, string> = {
  primary:
    "bg-accent-600 text-white shadow-sm hover:bg-accent-700 active:bg-accent-800 disabled:bg-accent-300",
  secondary:
    "border border-neutral-300 bg-white text-neutral-800 shadow-sm hover:bg-neutral-50 disabled:text-neutral-400",
  ghost: "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900",
  danger:
    "bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-red-300",
};

const sizes: Record<Size, string> = {
  md: "min-h-11 px-4 py-2 text-sm",
  sm: "min-h-11 px-3 py-1.5 text-sm",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "primary", size = "md", loading = false, className = "", disabled, children, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:cursor-not-allowed ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      >
        {loading && (
          <span
            aria-hidden="true"
            className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        )}
        {children}
      </button>
    );
  },
);
