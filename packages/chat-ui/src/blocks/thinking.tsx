import { Brain, ChevronRight } from "lucide-react";

export function ThinkingBlock({ text }: { text: string }) {
  return (
    <details className="nova-thinking-block group rounded-lg bg-slate-50/80 px-2.5 py-1.5 text-slate-500 ring-1 ring-slate-200/60 dark:bg-slate-900/60 dark:text-slate-400 dark:ring-slate-800">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium select-none [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform duration-200 group-open:rotate-90" aria-hidden="true" />
        <Brain className="size-3.5" aria-hidden="true" />
        <span>思考过程</span>
      </summary>
      <div className="mt-1.5 border-t border-slate-200/70 pt-1.5 text-xs leading-5 whitespace-pre-wrap dark:border-slate-800">{text}</div>
    </details>
  );
}
