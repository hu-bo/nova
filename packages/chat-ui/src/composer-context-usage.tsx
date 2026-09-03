import { CircleGauge } from "lucide-react";
import type { ComposerContextUsage } from "./composer-types.js";

export function contextUsagePercent(usage: ComposerContextUsage): number {
  if (usage.maxInputTokens <= 0) return 0;
  if (usage.estimatedInputTokens === 0) return 0;
  return Math.min(100, Math.max(1, Math.ceil((usage.estimatedInputTokens / usage.maxInputTokens) * 100)));
}

export function ComposerContextUsageIndicator({ usage }: { usage: ComposerContextUsage }) {
  const percent = contextUsagePercent(usage);
  const label = `上下文 ≈${percent}%`;
  const detail = `${label}（≈${usage.estimatedInputTokens.toLocaleString()} / ${usage.maxInputTokens.toLocaleString()} tokens）`;
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
