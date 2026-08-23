import type { ComponentProps } from "react";
import { cn } from "../../lib/cn.js";

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn("flex min-h-20 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-[15px] leading-6 text-slate-900 outline-none transition-[border-color,box-shadow] placeholder:text-slate-400 focus-visible:border-indigo-500 focus-visible:ring-3 focus-visible:ring-indigo-500/15 disabled:cursor-not-allowed disabled:opacity-50 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-100 dark:placeholder:text-slate-600", className)} {...props} />;
}
