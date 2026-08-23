import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge.js";

export function PageHeader({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <header className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-indigo-600">{eyebrow}</p>
        <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {action}
    </header>
  );
}

export function StatusBadge({ enabled, enabledLabel = "已启用", disabledLabel = "已停用" }: { enabled: boolean; enabledLabel?: string; disabledLabel?: string }) {
  return <Badge variant={enabled ? "success" : "default"}><span className={cn("size-1.5 rounded-full", enabled ? "bg-emerald-500" : "bg-slate-400")} aria-hidden="true" />{enabled ? enabledLabel : disabledLabel}</Badge>;
}

export function TableFrame({ children }: { children: ReactNode }) {
  return <div data-slot="table-container" className="overflow-x-auto rounded-xl bg-card ring-1 ring-slate-200 shadow-soft">{children}</div>;
}

export const tableHeadClass = "bg-slate-50/80 text-left text-xs font-semibold uppercase tracking-wide text-slate-500";
export const tableCellClass = "px-5 py-4 align-middle text-sm text-slate-600";
