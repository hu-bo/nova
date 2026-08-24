import { ChevronUp, FileDiff, UnfoldVertical } from "lucide-react";
import { useState, type ReactNode } from "react";

interface DiffLine {
  text: string;
  kind: "add" | "remove" | "meta" | "context";
}

function classify(text: string): DiffLine {
  if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")) return { text, kind: "meta" };
  if (text.startsWith("+")) return { text, kind: "add" };
  if (text.startsWith("-")) return { text, kind: "remove" };
  return { text, kind: "context" };
}

function visibleLines(lines: DiffLine[], expanded: boolean): Array<DiffLine | { omitted: number }> {
  if (expanded) return lines;
  const result: Array<DiffLine | { omitted: number }> = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index]?.kind !== "context") {
      result.push(lines[index]!);
      index += 1;
      continue;
    }
    let end = index;
    while (lines[end]?.kind === "context") end += 1;
    const length = end - index;
    if (length <= 6) result.push(...lines.slice(index, end));
    else result.push(...lines.slice(index, index + 3), { omitted: length - 6 }, ...lines.slice(end - 3, end));
    index = end;
  }
  return result;
}

export function DiffBlock({
  path,
  diff,
  added,
  removed,
  onOpenPath,
}: {
  path: string;
  diff: string;
  added: number;
  removed: number;
  onOpenPath?: ((path: string) => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = diff.split("\n").map(classify);
  const hasFold = lines.some(
    (line, index) => line.kind === "context" && lines.slice(index, index + 7).every((item) => item.kind === "context"),
  );
  const content: ReactNode[] = visibleLines(lines, expanded).map((line, index) => {
    if ("omitted" in line)
      return (
        <button
          type="button"
          key={index}
          onClick={() => setExpanded(true)}
          className="flex w-full items-center justify-center gap-2 border-y border-slate-200 bg-slate-50 py-1.5 text-[11px] text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 dark:border-slate-800 dark:bg-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <UnfoldVertical className="size-3" aria-hidden="true" />
          {line.omitted} 行未变更内容
        </button>
      );
    const className =
      line.kind === "add"
        ? "bg-emerald-50 text-emerald-950 dark:bg-emerald-950/35 dark:text-emerald-200"
        : line.kind === "remove"
          ? "bg-rose-50 text-rose-950 dark:bg-rose-950/35 dark:text-rose-200"
          : line.kind === "meta"
            ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950/35 dark:text-indigo-300"
            : "text-slate-600 dark:text-slate-400";
    return (
      <div key={index} className={`min-h-[1.5rem] px-3 ${className}`}>
        {line.text || " "}
      </div>
    );
  });

  return (
    <section className="nova-diff-block min-w-0 overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-950 dark:ring-slate-800">
      <header className="flex min-h-9 items-center gap-2.5 border-b border-slate-200/70 px-3 dark:border-slate-800">
        <FileDiff className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
        <button
          type="button"
          onClick={() => onOpenPath?.(path)}
          disabled={!onOpenPath}
          className="min-w-0 flex-1 truncate text-left font-mono text-[11px] font-medium text-slate-600 transition-colors hover:text-indigo-600 disabled:cursor-default dark:text-slate-300 dark:hover:text-indigo-400"
        >
          {path}
        </button>
        <span className="shrink-0 font-mono text-[11px]">
          <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>
          <span className="mx-1 text-slate-300 dark:text-slate-700">/</span>
          <span className="text-rose-600 dark:text-rose-400">-{removed}</span>
        </span>
        {hasFold && expanded && (
          <button
            type="button"
            onClick={() => setExpanded(false)}
            aria-label="折叠上下文"
            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <ChevronUp className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </header>
      <pre className="m-0 overflow-x-auto py-1.5 font-mono text-xs leading-5">{content}</pre>
    </section>
  );
}
