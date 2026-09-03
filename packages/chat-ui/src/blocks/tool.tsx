import { CheckCircle2, ChevronRight, CircleOff, LoaderCircle, TerminalSquare, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import type { Block } from "@nova/protocol";
import type { ExtractBlock } from "../types.js";

const MAX_OUTPUT_CHARS = 12_000;

function formatArgs(args: unknown): string {
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function formatOutput(blocks: Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
        case "thinking":
        case "code":
          return block.type === "code" ? block.code : block.text;
        case "diff":
          return block.diff;
        case "error":
          return `${block.code}: ${block.message}`;
        // Compatibility for persisted messages created before tool output became plain text.
        case "file":
          return block.path;
        case "todo":
          return block.items.map((item) => `- [${item.status}] ${item.text}`).join("\n");
        case "tool_call":
          return `${block.name}\n${formatArgs(block.args)}`;
        case "tool_result":
          return formatOutput(block.blocks);
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n… 已省略 ${output.length - MAX_OUTPUT_CHARS} 个字符`;
}

function formatSize(chars: number): string {
  if (chars < 1024) return `${chars} 字符`;
  return `${(chars / 1024).toFixed(1)} KB`;
}

function getCallSummary(call: ExtractBlock<"tool_call">): string | undefined {
  if (!call.args || typeof call.args !== "object") return undefined;

  if (call.name === "bash" && "command" in call.args && typeof call.args.command === "string") {
    const args = "args" in call.args && Array.isArray(call.args.args) ? call.args.args : [];
    return [call.args.command, ...args.map(String)].join(" ");
  }

  return "path" in call.args && typeof call.args.path === "string" ? call.args.path : undefined;
}

function Section({
  label,
  badge,
  defaultOpen,
  forceOpen,
  children,
}: {
  label: string;
  badge?: string;
  defaultOpen: boolean;
  forceOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      open={forceOpen || defaultOpen}
      className="nova-tool-section group/section border-t border-slate-200/70 first:border-t-0 dark:border-slate-800/80"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 bg-slate-100/60 px-2.5 py-1 text-[11px] font-medium tracking-wide text-slate-500 uppercase select-none hover:bg-slate-200/60 hover:text-slate-700 dark:bg-slate-900/40 dark:hover:bg-slate-800/60 dark:hover:text-slate-300 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-slate-400 transition-transform duration-200 group-open/section:rotate-90"
          aria-hidden="true"
        />
        <span>{label}</span>
        {badge && (
          <span className="rounded bg-white/80 px-1.5 py-px font-mono text-[10px] normal-case text-slate-500 ring-1 ring-slate-200/70 dark:bg-slate-950/60 dark:text-slate-400 dark:ring-slate-700/70">
            {badge}
          </span>
        )}
      </summary>
      <div>{children}</div>
    </details>
  );
}

export function ToolBlock({
  call,
  result,
}: {
  call: ExtractBlock<"tool_call">;
  result?: ExtractBlock<"tool_result"> | undefined;
}) {
  const status = result?.status ?? call.status;
  const open = call.status === "running" || result?.status === "error";
  const StatusIcon =
    status === "running" ? LoaderCircle : status === "ok" ? CheckCircle2 : status === "cancelled" ? CircleOff : XCircle;
  const statusLabel =
    status === "running" ? "运行中" : status === "ok" ? "已完成" : status === "cancelled" ? "已取消" : "失败";
  const statusColor =
    status === "running"
      ? "text-indigo-500"
      : status === "ok"
        ? "text-emerald-500"
        : status === "cancelled"
          ? "text-slate-400"
          : "text-rose-500";

  const argsText = formatArgs(call.args);
  const output = result ? truncateOutput(formatOutput(result.blocks)) : "";
  const isRunning = status === "running";
  const summary = getCallSummary(call);

  return (
    <details
      data-status={status}
      className="nova-tool-block group overflow-hidden rounded-xl bg-slate-50/70 ring-1 ring-slate-200/70 open:bg-white dark:bg-slate-900/60 dark:ring-slate-800 dark:open:bg-slate-950"
      open={open}
    >
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 px-2.5 text-xs select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 text-slate-400 transition-transform duration-200 group-open:rotate-90"
          aria-hidden="true"
        />
        <TerminalSquare className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <strong className="shrink-0 font-mono font-medium text-slate-700 dark:text-slate-300">{call.name}</strong>
          {summary && (
            <span className="min-w-0 truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={summary}>
              {summary}
            </span>
          )}
        </div>
        <span
          aria-label={`状态：${call.status}`}
          className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] ${statusColor}`}
        >
          <StatusIcon
            className={`size-3.5 ${status === "running" ? "animate-spin motion-reduce:animate-none" : ""}`}
            aria-hidden="true"
          />
          {statusLabel}
        </span>
      </summary>

      <Section label="参数" badge={formatSize(argsText.length)} defaultOpen={false}>
        <pre className="nova-scrollbar m-0 max-h-56 overflow-auto bg-slate-950 px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-slate-300">
          {argsText}
        </pre>
      </Section>

      {output && (
        <Section
          label={result?.status === "error" ? "错误输出" : "输出"}
          badge={formatSize(output.length)}
          defaultOpen={false}
          forceOpen={isRunning || status === "error"}
        >
          <pre className="nova-scrollbar m-0 max-h-80 overflow-auto bg-slate-950 px-3 py-2.5 font-mono text-[11px] leading-5 whitespace-pre-wrap text-slate-300">
            {output}
          </pre>
        </Section>
      )}
    </details>
  );
}
