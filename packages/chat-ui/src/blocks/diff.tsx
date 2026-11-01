import { DiffFile, DiffModeEnum, DiffView } from "@git-diff-view/react";
import { FileDiff } from "lucide-react";
import { useMemo } from "react";

export { unifiedPatchOf } from "./diff-utils.js";

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
  const diffFile = useMemo(() => {
    // The viewer requires file headers even when the protocol supplies only hunks.
    const patch = diff.startsWith("@@") ? `--- ${path}\n+++ ${path}\n${diff}` : diff;
    const file = new DiffFile(path, "", path, "", [patch]);
    file.initRaw();
    file.buildUnifiedDiffLines();
    return file;
  }, [path, diff]);

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
      </header>
      <DiffView
        diffFile={diffFile}
        diffViewMode={DiffModeEnum.Unified}
        diffViewHighlight={false}
        diffViewWrap={false}
      />
    </section>
  );
}
