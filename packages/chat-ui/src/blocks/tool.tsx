import { CheckCircle2, ChevronRight, CircleOff, LoaderCircle, TerminalSquare, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { ExtractBlock } from "../types.js";

function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); }
  catch { return String(args); }
}

export function ToolBlock({ call, result, children }: { call: ExtractBlock<"tool_call">; result?: ExtractBlock<"tool_result"> | undefined; children?: ReactNode | undefined }) {
  const status = result?.status ?? call.status;
  const open = call.status === "running" || result?.status === "error";
  const StatusIcon = status === "running" ? LoaderCircle : status === "ok" ? CheckCircle2 : status === "cancelled" ? CircleOff : XCircle;
  const statusLabel = status === "running" ? "运行中" : status === "ok" ? "已完成" : status === "cancelled" ? "已取消" : "失败";
  const statusColor = status === "running" ? "text-indigo-500" : status === "ok" ? "text-emerald-500" : status === "cancelled" ? "text-slate-400" : "text-rose-500";

  return (
    <details data-status={status} className="nova-tool-block group overflow-hidden rounded-xl bg-slate-50/70 ring-1 ring-slate-200/70 open:bg-white dark:bg-slate-900/60 dark:ring-slate-800 dark:open:bg-slate-950" open={open}>
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-xs select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        <TerminalSquare className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
        <strong className="min-w-0 flex-1 truncate font-mono font-medium text-slate-700 dark:text-slate-300">{call.name}</strong>
        <span aria-label={`状态：${call.status}`} className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] ${statusColor}`}>
          <StatusIcon className={`size-3.5 ${status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`} aria-hidden="true" />{statusLabel}
        </span>
      </summary>
      <div className="border-t border-slate-200/70 dark:border-slate-800">
        <pre className="m-0 max-h-56 overflow-auto bg-slate-950 px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-slate-300">{formatArgs(call.args)}</pre>
        {children && <div className="grid gap-2 p-2.5">{children}</div>}
      </div>
    </details>
  );
}
