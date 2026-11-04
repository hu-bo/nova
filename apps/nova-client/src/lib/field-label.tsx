import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';

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
