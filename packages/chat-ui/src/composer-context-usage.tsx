import { CircleGauge } from "lucide-react";
import type { ComposerContextUsage } from "./composer-types.js";

export function contextUsagePercent(usage: ComposerContextUsage): number | null {
  if (usage.inputTokens === null || usage.contextWindow <= 0) return null;
  // 只要已经测到 token，就不要显示成 0%；否则用户会误以为上下文为空。
  return Math.min(100, Math.max(0, Math.ceil((usage.inputTokens / usage.contextWindow) * 100)));
}

export function ComposerContextUsageIndicator({ usage }: { usage: ComposerContextUsage }) {
  const percent = contextUsagePercent(usage);
  const label = percent === null ? "上下文待测量" : `上下文 ${percent}%`;
  const detail =
    percent === null
      ? label
      : `${label}（${usage.inputTokens!.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens）`;
  return (
    <span
      className="hidden h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 sm:inline-flex dark:text-slate-400"
      aria-label={detail}
      title={detail}
    >
      <CircleGauge className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}
