import { File, Folder, HardDrive } from "lucide-react";

function formatBytes(size: number): string {
  if (size < 1_024) return `${size} B`;
  if (size < 1_048_576) return `${(size / 1_024).toFixed(1)} KB`;
  return `${(size / 1_048_576).toFixed(1)} MB`;
}

export function FileBlock({ path, kind, size, onOpenPath }: { path: string; kind: "file" | "dir"; size?: number | undefined; onOpenPath?: ((path: string) => void) | undefined }) {
  const Icon = kind === "dir" ? Folder : File;
  return (
    <button type="button" className="nova-file-block group flex w-full min-w-0 items-center gap-2.5 rounded-xl bg-white px-3 py-2 text-left shadow-sm ring-1 ring-slate-200/80 transition-all hover:-translate-y-px hover:ring-slate-300 disabled:cursor-default dark:bg-slate-950 dark:ring-slate-800 dark:hover:ring-slate-700" onClick={() => onOpenPath?.(path)} disabled={!onOpenPath}>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-slate-50 text-slate-500 ring-1 ring-slate-200/70 transition-colors group-hover:bg-indigo-50 group-hover:text-indigo-600 dark:bg-slate-900 dark:ring-slate-800 dark:group-hover:bg-indigo-950/50 dark:group-hover:text-indigo-400"><Icon className="size-4" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700 dark:text-slate-300">{path}</span>
      {size !== undefined && <small className="inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-400"><HardDrive className="size-3" aria-hidden="true" />{formatBytes(size)}</small>}
    </button>
  );
}
