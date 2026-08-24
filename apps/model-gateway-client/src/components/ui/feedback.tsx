import { AlertCircle, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ApiClientError } from "../../api/errors.js";
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

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = error instanceof ApiClientError && error.status === 403;
  return (
    <div
      data-slot="alert"
      className={cn("rounded-xl p-5 ring-1", forbidden ? "bg-amber-50 ring-amber-200" : "bg-rose-50 ring-rose-200")}
      role="alert"
    >
      <div className="flex gap-3">
        {forbidden ? (
          <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-700" aria-hidden="true" />
        ) : (
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-rose-600" aria-hidden="true" />
        )}
        <div className="min-w-0">
          <h3 className={cn("font-semibold", forbidden ? "text-amber-950" : "text-rose-900")}>
            {forbidden ? "需要管理员权限" : "加载失败"}
          </h3>
          <p className={cn("mt-1 break-words text-sm leading-6", forbidden ? "text-amber-800" : "text-rose-700")}>
            {error instanceof Error ? error.message : "发生未知错误"}
          </p>
          {onRetry && !forbidden && (
            <Button type="button" variant="secondary" className="mt-3" onClick={onRetry}>
              重试
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-500">{icon}</div>
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
