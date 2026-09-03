import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.js";
import { Button } from "./ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

export interface CopyButtonProps {
  text: string;
  label: string;
  className?: string | undefined;
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
    try {
      if (!globalThis.navigator?.clipboard) throw new Error("Clipboard API is unavailable");
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      setStatus("error");
    }

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
          ) : (
            <Copy aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipContent>{feedback}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
