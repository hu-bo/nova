import { ArrowUp, Check, Folder, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { useRunnerDirectories } from "./use-runners.js";

interface WorkspacePickerProps {
  runnerId: string;
  value: string;
  onChange: (path: string) => void;
}

export function WorkspacePicker({ runnerId, value, onChange }: WorkspacePickerProps) {
  const [browsePath, setBrowsePath] = useState<string>();
  const directories = useRunnerDirectories(runnerId, browsePath);

  useEffect(() => {
    setBrowsePath(value || undefined);
  }, [runnerId, value]);

  if (!runnerId) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
        请先选择 Runner
      </div>
    );
  }

  if (directories.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-6 text-sm text-slate-500">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        正在读取目录…
      </div>
    );
  }

  if (directories.error || !directories.data) {
    return (
      <div className="rounded-xl bg-rose-50 p-4 text-sm text-rose-700 ring-1 ring-rose-200">
        <p>{errorMessage(directories.error ?? new Error("目录读取失败"))}</p>
        <Button type="button" className="mt-3" onClick={() => void directories.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  const current = directories.data;
  return (
    <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
        <Button
          type="button"
          variant="ghost"
          className="shrink-0"
          disabled={!current.parent}
          onClick={() => setBrowsePath(current.parent ?? undefined)}
          icon={<ArrowUp className="size-4" aria-hidden="true" />}
        >
          上一级
        </Button>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-600" title={current.path}>
          {current.path}
        </span>
      </div>
      <div className="max-h-56 overflow-y-auto p-2">
        {current.directories.length ? (
          current.directories.map((directory) => (
            <button
              key={directory.path}
              type="button"
              onClick={() => setBrowsePath(directory.path)}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-indigo-50 hover:text-indigo-700"
            >
              <Folder className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{directory.name}</span>
            </button>
          ))
        ) : (
          <p className="px-3 py-6 text-center text-sm text-slate-400">此文件夹没有子目录</p>
        )}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-slate-200 px-3 py-2.5">
        <span className="min-w-0 truncate text-xs text-slate-500" title={value}>
          {value ? `已选择：${value}` : "尚未选择 workspace"}
        </span>
        <Button
          type="button"
          variant={value === current.path ? "outline" : "primary"}
          onClick={() => onChange(current.path)}
          icon={<Check className="size-4" aria-hidden="true" />}
        >
          {value === current.path ? "已选择" : "选择此文件夹"}
        </Button>
      </div>
    </div>
  );
}
