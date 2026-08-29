import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { Button } from "./components/ui/button.js";

export interface RemoteExplorerEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface RemoteExplorerListing {
  root: string;
  path: string;
  parent: string | null;
  entries: readonly RemoteExplorerEntry[];
}

export interface RemoteExplorerProps {
  open: boolean;
  onClose: () => void;
  loadDirectory: (path?: string, signal?: AbortSignal) => Promise<RemoteExplorerListing>;
  mode: "file" | "directory";
  multiple?: boolean | undefined;
  initialPath?: string | undefined;
  selectedPaths?: readonly string[] | undefined;
  onSelectionChange?: ((paths: string[]) => void) | undefined;
  onConfirm: (entries: RemoteExplorerEntry[]) => void | Promise<void>;
  title?: string | undefined;
}

type HistoryAction = { kind: "reset" | "push" } | { kind: "move"; index: number };
const EMPTY_PATHS: readonly string[] = [];

function sortEntries(entries: readonly RemoteExplorerEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function basename(path: string) {
  const stripped = path.replace(/[\\/]+$/, "");
  return stripped.split(/[\\/]/).at(-1) || path;
}

function breadcrumbs(root: string, path: string) {
  const separator = root.includes("\\") ? "\\" : "/";
  const normalizedRoot = root.replace(/[\\/]+$/, "");
  const normalizedPath = path.replace(/[\\/]+$/, "");
  const lowerRoot = normalizedRoot.toLocaleLowerCase();
  const lowerPath = normalizedPath.toLocaleLowerCase();
  const pathStartsAtRoot =
    lowerPath === lowerRoot ||
    (lowerPath.startsWith(lowerRoot) &&
      /^[\\/]/.test(normalizedPath.slice(normalizedRoot.length, normalizedRoot.length + 1)));
  const remainder = pathStartsAtRoot ? normalizedPath.slice(normalizedRoot.length).replace(/^[\\/]+/, "") : "";
  const items = [{ label: basename(root), path: root }];
  if (!remainder) return items;
  let current = normalizedRoot;
  for (const segment of remainder.split(/[\\/]+/).filter(Boolean)) {
    current += `${separator}${segment}`;
    items.push({ label: segment, path: current });
  }
  return items;
}

export function RemoteExplorer({
  open,
  onClose,
  loadDirectory,
  mode,
  multiple = false,
  initialPath,
  selectedPaths = EMPTY_PATHS,
  onSelectionChange,
  onConfirm,
  title = mode === "directory" ? "选择目录" : "选择文件",
}: RemoteExplorerProps) {
  const [listing, setListing] = useState<RemoteExplorerListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [selected, setSelected] = useState<Map<string, RemoteExplorerEntry>>(new Map());
  const [history, setHistory] = useState<{ paths: string[]; index: number }>({ paths: [], index: -1 });
  const selectionAnchor = useRef<number | null>(null);
  const abortController = useRef<AbortController | null>(null);
  const requestNumber = useRef(0);
  const requestedPath = useRef<string | undefined>(initialPath);
  const loadDirectoryRef = useRef(loadDirectory);
  const selectedPathsRef = useRef(selectedPaths);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId().replace(/:/g, "");

  const entries = useMemo(() => sortEntries(listing?.entries ?? []), [listing]);
  const crumbs = useMemo(() => (listing ? breadcrumbs(listing.root, listing.path) : []), [listing]);
  const matchingSelection = useMemo(
    () => [...selected.values()].filter((entry) => entry.kind === mode),
    [mode, selected],
  );
  const confirmEntries = useMemo(() => {
    if (matchingSelection.length || mode === "file" || !listing) return matchingSelection;
    return [{ name: basename(listing.path), path: listing.path, kind: "directory" as const }];
  }, [listing, matchingSelection, mode]);
  loadDirectoryRef.current = loadDirectory;
  selectedPathsRef.current = selectedPaths;

  const replaceSelection = useCallback(
    (next: Map<string, RemoteExplorerEntry>) => {
      setSelected(next);
      onSelectionChange?.([...next.keys()]);
    },
    [onSelectionChange],
  );

  const navigate = useCallback(async (path: string | undefined, historyAction: HistoryAction) => {
    abortController.current?.abort();
    const controller = new AbortController();
    abortController.current = controller;
    requestedPath.current = path;
    const request = ++requestNumber.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadDirectoryRef.current(path, controller.signal);
      if (controller.signal.aborted || request !== requestNumber.current) return;
      setListing(next);
      setActiveIndex(next.entries.length ? 0 : -1);
      selectionAnchor.current = null;
      setSelected(() => {
        const allowed = new Set(selectedPathsRef.current);
        const seeded = new Map<string, RemoteExplorerEntry>();
        for (const entry of next.entries) {
          if (allowed.has(entry.path)) seeded.set(entry.path, entry);
        }
        return seeded;
      });
      setHistory((current) => {
        if (historyAction.kind === "reset") return { paths: [next.path], index: 0 };
        if (historyAction.kind === "move") return { ...current, index: historyAction.index };
        if (current.paths[current.index] === next.path) return current;
        const paths = [...current.paths.slice(0, current.index + 1), next.path];
        return { paths, index: paths.length - 1 };
      });
      requestAnimationFrame(() => listRef.current?.focus());
    } catch (reason) {
      if (controller.signal.aborted || request !== requestNumber.current) return;
      setError(reason instanceof Error ? reason.message : "无法读取此目录");
    } finally {
      if (request === requestNumber.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) {
      abortController.current?.abort();
      return;
    }
    setListing(null);
    setHistory({ paths: [], index: -1 });
    setSelected(new Map());
    void navigate(initialPath, { kind: "reset" });
    return () => abortController.current?.abort();
  }, [initialPath, navigate, open]);

  useEffect(() => {
    if (!open || !listing) return;
    const paths = new Set(selectedPaths);
    const next = new Map<string, RemoteExplorerEntry>();
    for (const entry of entries) {
      if (paths.has(entry.path)) next.set(entry.path, entry);
    }
    setSelected(next);
  }, [entries, listing, open, selectedPaths]);

  function selectable(entry: RemoteExplorerEntry) {
    return entry.kind === mode;
  }

  function selectEntry(entry: RemoteExplorerEntry, index: number, event?: MouseEvent) {
    setActiveIndex(index);
    if (!selectable(entry)) {
      if (!event?.shiftKey && !event?.metaKey && !event?.ctrlKey) replaceSelection(new Map());
      selectionAnchor.current = index;
      return;
    }

    const toggle = multiple && Boolean(event?.metaKey || event?.ctrlKey);
    const range = multiple && Boolean(event?.shiftKey) && selectionAnchor.current !== null;
    if (range) {
      const start = Math.min(selectionAnchor.current!, index);
      const end = Math.max(selectionAnchor.current!, index);
      const next = new Map(selected);
      for (const candidate of entries.slice(start, end + 1)) {
        if (selectable(candidate)) next.set(candidate.path, candidate);
      }
      replaceSelection(next);
      return;
    }
    if (toggle) {
      const next = new Map(selected);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.set(entry.path, entry);
      replaceSelection(next);
    } else {
      replaceSelection(new Map([[entry.path, entry]]));
    }
    selectionAnchor.current = index;
  }

  function openEntry(entry: RemoteExplorerEntry) {
    if (entry.kind === "directory") {
      void navigate(entry.path, { kind: "push" });
    } else if (mode === "file") {
      void onConfirm([entry]);
    }
  }

  function moveActive(offset: number, event: KeyboardEvent<HTMLDivElement>) {
    if (!entries.length) return;
    const nextIndex = activeIndex < 0 ? 0 : Math.max(0, Math.min(entries.length - 1, activeIndex + offset));
    setActiveIndex(nextIndex);
    const entry = entries[nextIndex];
    if (entry && selectable(entry)) {
      selectEntry(entry, nextIndex, event as unknown as MouseEvent);
    }
    document.getElementById(`${listId}-${nextIndex}`)?.scrollIntoView({ block: "nearest" });
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "a" && multiple) {
      event.preventDefault();
      replaceSelection(new Map(entries.filter(selectable).map((entry) => [entry.path, entry])));
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveActive(event.key === "ArrowDown" ? 1 : -1, event);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const active = entries[activeIndex];
      if (active?.kind === "directory") openEntry(active);
      else if (matchingSelection.length) void onConfirm(matchingSelection);
      return;
    }
    if (event.key === "Backspace" && !event.metaKey && !event.ctrlKey && listing?.parent) {
      event.preventDefault();
      void navigate(listing.parent, { kind: "push" });
    }
  }

  function close(openState: boolean) {
    if (!openState) onClose();
  }

  return (
    <Dialog.Root open={open} onOpenChange={close}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-slate-950/45 backdrop-blur-sm transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <Dialog.Viewport className="fixed inset-0 z-50 grid place-items-center overflow-y-auto p-3 sm:p-6">
          <Dialog.Popup
            initialFocus={listRef}
            className="nova-remote-explorer flex h-[min(44rem,calc(100dvh-1.5rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white text-slate-900 shadow-2xl ring-1 ring-slate-950/10 transition-[transform,scale,opacity] duration-150 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0 dark:bg-slate-950 dark:text-slate-100 dark:ring-white/10 motion-reduce:transition-none"
          >
            <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
              <FolderOpen className="size-5 shrink-0 text-indigo-500" aria-hidden="true" />
              <Dialog.Title className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</Dialog.Title>
              <Dialog.Description className="sr-only">
                {mode === "directory" ? "浏览远程目录并选择一个或多个目录" : "浏览远程目录并选择一个或多个文件"}
              </Dialog.Description>
              <Dialog.Close
                aria-label="关闭"
                className="grid size-8 shrink-0 place-items-center rounded-lg text-slate-500 outline-none hover:bg-slate-100 focus-visible:ring-3 focus-visible:ring-indigo-500/25 dark:hover:bg-slate-800"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </header>

            <div className="flex min-w-0 items-center gap-1 border-b border-slate-200 px-3 py-2 dark:border-slate-800">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="后退"
                disabled={loading || history.index <= 0}
                onClick={() => {
                  const index = history.index - 1;
                  void navigate(history.paths[index], { kind: "move", index });
                }}
              >
                <ArrowLeft aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="前进"
                disabled={loading || history.index < 0 || history.index >= history.paths.length - 1}
                onClick={() => {
                  const index = history.index + 1;
                  void navigate(history.paths[index], { kind: "move", index });
                }}
              >
                <ArrowRight aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="上级目录"
                disabled={loading || !listing?.parent}
                onClick={() => listing?.parent && void navigate(listing.parent, { kind: "push" })}
              >
                <FolderOpen aria-hidden="true" />
              </Button>

              <nav
                aria-label="当前路径"
                className="ml-1 flex min-w-0 flex-1 items-center overflow-x-auto rounded-lg bg-slate-50 px-1 py-0.5 dark:bg-slate-900"
              >
                {crumbs.map((crumb, index) => (
                  <span key={crumb.path} className="flex shrink-0 items-center">
                    {index > 0 && <ChevronRight className="size-3.5 text-slate-400" aria-hidden="true" />}
                    <button
                      type="button"
                      disabled={loading || index === crumbs.length - 1}
                      className="max-w-40 truncate rounded-md px-2 py-1 text-xs text-slate-600 outline-none hover:bg-white hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-indigo-500/30 disabled:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white dark:disabled:text-slate-100"
                      onClick={() => void navigate(crumb.path, { kind: "push" })}
                    >
                      {crumb.label}
                    </button>
                  </span>
                ))}
              </nav>
            </div>

            <div className="relative min-h-0 flex-1">
              {error && !listing ? (
                <div className="grid h-full min-h-44 place-items-center p-6 text-center sm:min-h-72" role="alert">
                  <div>
                    <p className="text-sm font-medium">无法读取目录</p>
                    <p className="mt-1 max-w-md text-xs text-slate-500 dark:text-slate-400">{error}</p>
                    <Button
                      className="mt-4"
                      type="button"
                      variant="outline"
                      onClick={() => void navigate(requestedPath.current, { kind: "push" })}
                    >
                      <RefreshCw aria-hidden="true" />
                      重试
                    </Button>
                  </div>
                </div>
              ) : (
                <div
                  ref={listRef}
                  role="listbox"
                  tabIndex={0}
                  aria-label="目录内容"
                  aria-busy={loading}
                  aria-multiselectable={multiple || undefined}
                  aria-activedescendant={activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
                  onKeyDown={keyDown}
                  className="h-full min-h-44 overflow-y-auto p-2 outline-none focus-visible:ring-3 focus-visible:ring-inset focus-visible:ring-indigo-500/20 sm:min-h-72"
                >
                  {!loading && entries.length === 0 && (
                    <div className="grid min-h-64 place-items-center text-center text-sm text-slate-500 dark:text-slate-400">
                      此目录为空
                    </div>
                  )}
                  {entries.map((entry, index) => {
                    const isSelected = selected.has(entry.path);
                    const isActive = activeIndex === index;
                    const canSelect = selectable(entry);
                    return (
                      <div
                        id={`${listId}-${index}`}
                        key={entry.path}
                        role="option"
                        aria-selected={isSelected}
                        onClick={(event) => selectEntry(entry, index, event)}
                        onDoubleClick={() => openEntry(entry)}
                        className="group flex min-h-10 cursor-default select-none items-center gap-2 rounded-lg px-3 py-2 text-sm outline-none transition-colors hover:bg-slate-100 aria-selected:bg-indigo-50 aria-selected:text-indigo-950 dark:hover:bg-slate-900 dark:aria-selected:bg-indigo-950/50 dark:aria-selected:text-indigo-100"
                        data-active={isActive || undefined}
                      >
                        {entry.kind === "directory" ? (
                          <Folder
                            className="size-4 shrink-0 fill-indigo-100 text-indigo-500 dark:fill-indigo-950"
                            aria-hidden="true"
                          />
                        ) : (
                          <File className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                        )}
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        {!canSelect && <span className="text-[11px] text-slate-400">双击打开</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {loading && (
                <div
                  className="pointer-events-none absolute inset-0 grid place-items-center bg-white/65 dark:bg-slate-950/65"
                  role="status"
                  aria-label="正在读取目录"
                >
                  <LoaderCircle
                    className="size-6 animate-spin text-indigo-500 motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                </div>
              )}
              {error && listing && (
                <div
                  className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 shadow ring-1 ring-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:ring-rose-900"
                  role="alert"
                >
                  <span className="truncate">{error}</span>
                  <button
                    type="button"
                    className="shrink-0 font-medium underline"
                    onClick={() => void navigate(requestedPath.current, { kind: "push" })}
                  >
                    重试
                  </button>
                </div>
              )}
            </div>

            <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 dark:border-slate-800">
              <p className="min-w-0 flex-1 text-xs text-slate-500 dark:text-slate-400">
                {matchingSelection.length
                  ? `已选择 ${matchingSelection.length} 项`
                  : mode === "directory" && listing
                    ? `将选择当前目录：${basename(listing.path)}`
                    : multiple
                      ? "可按 Shift 或 ⌘/Ctrl 多选"
                      : "双击目录进入"}
              </p>
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" onClick={onClose}>
                  取消
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  disabled={!confirmEntries.length || loading}
                  onClick={() => void onConfirm(confirmEntries)}
                >
                  选择
                </Button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
