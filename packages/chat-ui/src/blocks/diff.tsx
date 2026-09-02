import { DiffModeEnum, DiffView } from "@git-diff-view/react";
import { FileDiff } from "lucide-react";
import { useMemo } from "react";

function patchContents(diff: string): { oldContent: string; newContent: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  let oldLine = 0;
  let newLine = 0;

  const padTo = (lines: string[], line: number) => {
    while (lines.length < line - 1) lines.push("");
  };

  for (const line of diff.split("\n")) {
    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      padTo(oldLines, oldLine);
      padTo(newLines, newLine);
      continue;
    }
    if (line.startsWith("\\")) continue;
    if (line.startsWith("-")) {
      padTo(oldLines, oldLine);
      oldLines[oldLine - 1] = line.slice(1);
      oldLine += 1;
    } else if (line.startsWith("+")) {
      padTo(newLines, newLine);
      newLines[newLine - 1] = line.slice(1);
      newLine += 1;
    } else if (line.startsWith(" ")) {
      const content = line.slice(1);
      padTo(oldLines, oldLine);
      padTo(newLines, newLine);
      oldLines[oldLine - 1] = content;
      newLines[newLine - 1] = content;
      oldLine += 1;
      newLine += 1;
    }
  }

  return { oldContent: oldLines.join("\n"), newContent: newLines.join("\n") };
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
  const { oldContent, newContent } = useMemo(() => patchContents(diff), [diff]);

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
        data={{
          oldFile: { fileName: path, content: oldContent },
          newFile: { fileName: path, content: newContent },
          hunks: [diff],
        }}
        diffViewMode={DiffModeEnum.Unified}
        diffViewHighlight={false}
        diffViewWrap={false}
      />
    </section>
  );
}
