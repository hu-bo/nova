import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

export interface CopyButtonProps {
  text: string;
  label: string;
  className?: string | undefined;
}

/**
 * 复制文本，兼容非安全上下文（HTTP）与旧 WebView。
 * Async Clipboard API 只在 HTTPS / localhost 暴露，移动端局域网访问通常拿不到；
 * 因此降级到隐藏 textarea + execCommand("copy")。降级路径必须在点击所在的同步任务里执行，
 * 以保留 transient user activation，所以这里在 await 之前完成 execCommand。
 */
async function copyToClipboard(value: string): Promise<boolean> {
  if (globalThis.navigator?.clipboard && globalThis.isSecureContext) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Clipboard API 被拒绝（权限 / 失活），继续走 execCommand 降级
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.readOnly = true;
    // 固定定位并透明，避免聚焦时页面跳动或出现光标
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "0";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({ text, label, className }: CopyButtonProps) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copy() {
    setStatus(await copyToClipboard(text) ? "copied" : "error");

    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setStatus("idle"), 1_500);
  }

  const feedback = status === "copied" ? "已复制" : status === "error" ? "复制失败" : label;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void copy()}
              aria-label={feedback}
              className={cn(className)}
            />
          }
        >
          {status === "copied" ? (
            <Check className="text-emerald-500" aria-hidden="true" />
          ) : status === "error" ? (
            <X className="text-rose-500" aria-hidden="true" />
          ) : (
            <Copy aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>{feedback}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
