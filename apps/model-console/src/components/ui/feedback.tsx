import { Alert as HeroUIAlert, Skeleton as HeroUISkeleton } from "@heroui/react";
import { AlertCircle, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ApiClientError, errorMessage } from "@/api/errors";
import { Button } from "@/components/ui/button";

export function LoadingState({ label = "正在加载" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="grid min-h-40 gap-3 py-2">
      <span className="sr-only">{label}</span>
      <HeroUISkeleton className="h-3 w-28 rounded-full" />
      <HeroUISkeleton className="h-14 rounded-xl" />
      <HeroUISkeleton className="h-14 rounded-xl" />
      <HeroUISkeleton className="h-14 w-4/5 rounded-xl" />
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const forbidden = error instanceof ApiClientError && error.status === 403;
  const notified = error instanceof ApiClientError && error.notified;
  if (notified && !onRetry) return null;
  return (
    <HeroUIAlert
      status={forbidden ? "warning" : "danger"}
      data-slot="alert"
      className={cn(
        "rounded-xl p-5",
        forbidden ? "bg-warning/10 text-warning-foreground" : "bg-danger/10 text-danger-foreground",
      )}
    >
      <HeroUIAlert.Indicator className="mt-0.5 shrink-0">
        {forbidden ? (
          <ShieldAlert className="size-5 text-warning" aria-hidden="true" />
        ) : (
          <AlertCircle className="size-5 text-danger" aria-hidden="true" />
        )}
      </HeroUIAlert.Indicator>
      <HeroUIAlert.Content>
        <HeroUIAlert.Title className={cn("font-semibold", forbidden ? "text-warning" : "text-danger")}>
          {forbidden ? "需要管理员权限" : "加载失败"}
        </HeroUIAlert.Title>
        <HeroUIAlert.Description
          className={cn("mt-1 break-words text-sm leading-6", forbidden ? "text-warning" : "text-danger")}
        >
          {notified ? "请重试，或稍后重新打开此页面。" : errorMessage(error)}
        </HeroUIAlert.Description>
        {onRetry && !forbidden && (
          <Button type="button" variant="secondary" className="mt-3" onPress={onRetry}>
            重试
          </Button>
        )}
      </HeroUIAlert.Content>
    </HeroUIAlert>
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
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">{icon}</div>
      <h3 className="font-semibold text-foreground">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
