import type { ComponentProps, ReactNode } from "react";

import { cn } from "@/lib/utils";

export const fieldClass =
  "mt-2 flex min-h-10 w-full rounded-xl border border-input bg-card px-3 py-2.5 text-sm text-slate-900 shadow-xs outline-none transition placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20";

export function FieldLabel({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <label data-slot="field-label" className="block text-sm font-medium text-slate-700">
      <span>{label}</span>
      {hint && <span className="ml-2 font-normal text-slate-400">{hint}</span>}
      {children}
      {error && (
        <span role="alert" className="mt-1.5 block text-xs font-medium text-destructive">
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className, type, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      type={type}
      className={cn(fieldClass, className)}
      aria-invalid={props["aria-invalid"]}
      {...props}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        fieldClass,
        "appearance-none bg-[linear-gradient(45deg,transparent_50%,currentColor_50%),linear-gradient(135deg,currentColor_50%,transparent_50%)] bg-[position:calc(100%-16px)_calc(50%-2px),calc(100%-12px)_calc(50%-2px)] bg-[size:4px_4px,4px_4px] bg-no-repeat pr-9",
        className,
      )}
      {...props}
    />
  );
}
