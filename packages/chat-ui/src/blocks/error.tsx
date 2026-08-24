import { CircleAlert } from "lucide-react";

export function ErrorBlock({ code, message }: { code: string; message: string }) {
  return (
    <div
      role="alert"
      className="nova-error-block flex items-start gap-2.5 rounded-xl bg-rose-50 px-3 py-2.5 text-rose-800 ring-1 ring-rose-200/80 dark:bg-rose-950/30 dark:text-rose-300 dark:ring-rose-900"
    >
      <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <strong className="block font-mono text-[11px] font-semibold uppercase tracking-wider">{code}</strong>
        <div className="mt-1 text-sm leading-5">{message}</div>
      </div>
    </div>
  );
}
