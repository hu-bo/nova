import { useState } from "react";
import { ChevronDown, Server } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { displayWorkspacePath } from "../../../lib/workspace-path.js";
import { RunnerManagerDialog } from "./runner-manager-dialog.js";
import { runnerStateLabel, useRunnerCatalog } from "./use-runners.js";

/**
 * Runner 选择入口：摘要按钮负责回显，选择本身复用设置页的 Runner 与连接令牌弹窗，
 * 那里同时提供 Runner、Token 管理与安装启动命令。
 */
export function RunnerPickerField({ value, onSelect }: { value: string; onSelect: (runnerId: string) => void }) {
  const [open, setOpen] = useState(false);
  const catalog = useRunnerCatalog();
  const selected = catalog.runners.find((runner) => runner.id === value);
  const summary = selected
    ? `${selected.id} · ${runnerStateLabel(selected.state)} · ${displayWorkspacePath(selected.rootWorkspace)}`
    : value
      ? value
      : catalog.isLoading
        ? "正在加载 Runner…"
        : "选择 Runner";

  return (
    <>
      <Button
        type="button"
        variant="outline"
        className="w-full justify-between"
        icon={<Server className="size-4 shrink-0" aria-hidden="true" />}
        onClick={() => setOpen(true)}
      >
        <span className="truncate text-left">{summary}</span>
        <ChevronDown className="size-4 shrink-0 opacity-60" aria-hidden="true" />
      </Button>
      <RunnerManagerDialog
        open={open}
        onClose={() => setOpen(false)}
        title="选择 Runner"
        {...(value ? { selectedRunnerId: value } : {})}
        onSelect={onSelect}
      />
    </>
  );
}
