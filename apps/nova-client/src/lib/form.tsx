import { AlertCircle, ChevronDown } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

/** 与 `components/ui/input.tsx` 一致的输入框样式，共用同一套主题 token。 */
export const fieldClass =
  'h-10 w-full rounded-xl border border-field-border bg-field-background px-3 text-sm text-field-foreground outline-none transition placeholder:text-field-placeholder focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus/30 disabled:pointer-events-none disabled:opacity-50';

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
    <label className="block">
      <span className="flex items-baseline gap-2 text-sm font-medium text-foreground">
        {label}
        {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
      </span>
      <span className="mt-2 block">{children}</span>
      {error && (
        <span
          role="alert"
          className="mt-1.5 flex items-center gap-1.5 text-xs font-medium text-danger"
        >
          <AlertCircle size={12} className="shrink-0" aria-hidden="true" />
          {error}
        </span>
      )}
    </label>
  );
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(fieldClass, className)} {...props} />;
}

export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative block">
      <select
        className={cn(fieldClass, 'cursor-pointer appearance-none pr-9', className)}
        {...props}
      />
      <ChevronDown
        size={15}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
    </span>
  );
}
