import { AlertCircle, WifiOff } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "./button.js";

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div className="grid min-h-40 animate-pulse gap-3 py-2 motion-reduce:animate-none" role="status" aria-label={label}>
      <span className="sr-only">{label}</span>
      <div className="h-3 w-28 rounded-full bg-slate-200" />
      <div className="h-14 rounded-xl bg-white ring-1 ring-slate-200" />
      <div className="h-14 rounded-xl bg-white ring-1 ring-slate-200" />
      <div className="h-14 w-4/5 rounded-xl bg-white ring-1 ring-slate-200" />
    </div>
  );
}

export function ErrorState({ title = "加载失败", message, onRetry }: { title?: string; message: string; onRetry?: () => void }) {
  return (
    <div className="rounded-xl bg-rose-50 p-5 ring-1 ring-rose-200" role="alert">
      <div className="flex gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden="true" />
        <div className="min-w-0">
          <h3 className="font-semibold text-rose-900">{title}</h3>
          <p className="mt-1 break-words text-sm leading-6 text-rose-700">{message}</p>
          {onRetry && <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>重试</Button>}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-xl bg-white px-6 py-10 text-center ring-1 ring-slate-200">
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-500">{icon ?? <WifiOff className="size-5" aria-hidden="true" />}</div>
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
