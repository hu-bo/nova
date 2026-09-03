import type { ProjectInstructions } from "@nova/protocol";
import { FileSearch, FileText, MessageSquareText, Power } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "../../api/client.js";
import { Button } from "../../components/ui/button.js";
import { Dialog } from "../../components/ui/dialog.js";
import { FieldLabel, Input, Textarea } from "../../components/ui/form.js";

export function ProjectInstructionsDialog({
  open,
  onClose,
  workspace,
  instructions,
  saving,
  error,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  workspace: string | null;
  instructions: ProjectInstructions;
  saving: boolean;
  error: unknown;
  onSave: (instructions: ProjectInstructions) => Promise<void>;
}) {
  const [source, setSource] = useState<ProjectInstructions["source"]>("auto");
  const [directory, setDirectory] = useState(".");
  const [content, setContent] = useState("");

  useEffect(() => {
    if (!open) return;
    setSource(instructions.source);
    setDirectory(instructions.source === "agents" || instructions.source === "claude" ? instructions.directory : ".");
    setContent(instructions.source === "custom" ? instructions.content : "");
  }, [instructions, open]);

  const canSave =
    !saving &&
    (source === "auto" ||
      source === "none" ||
      (source === "custom" ? content.trim().length > 0 : Boolean(directory.trim())));

  async function submit() {
    if (source === "auto") await onSave({ source: "auto" });
    else if (source === "none") await onSave({ source: "none" });
    else if (source === "custom") await onSave({ source: "custom", content: content.trim() });
    else await onSave({ source, directory: directory.trim() });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="项目指令"
      description="为这个 Project 的所有新运行时注入同一份仓库约束。"
    >
      <div className="space-y-5">
        <fieldset>
          <legend className="sr-only">指令来源</legend>
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
            <SourceOption
              active={source === "auto"}
              icon={<FileSearch className="size-4" aria-hidden="true" />}
              title="自动探测"
              description="依次查找 AGENTS.md、CLAUDE.md"
              onClick={() => setSource("auto")}
            />
            <SourceOption
              active={source === "agents"}
              icon={<FileText className="size-4" aria-hidden="true" />}
              title="AGENTS.md"
              description="从 workspace 目录读取"
              onClick={() => setSource("agents")}
            />
            <SourceOption
              active={source === "claude"}
              icon={<FileText className="size-4" aria-hidden="true" />}
              title="CLAUDE.md"
              description="从 workspace 目录读取"
              onClick={() => setSource("claude")}
            />
            <SourceOption
              active={source === "custom"}
              icon={<MessageSquareText className="size-4" aria-hidden="true" />}
              title="自定义提示词"
              description="直接保存在 Project 中"
              onClick={() => setSource("custom")}
            />
            <SourceOption
              active={source === "none"}
              icon={<Power className="size-4" aria-hidden="true" />}
              title="不使用"
              description="仅使用 Nova 默认规则"
              onClick={() => setSource("none")}
            />
          </div>
        </fieldset>

        {(source === "agents" || source === "claude") && (
          <FieldLabel label="所在目录" hint="相对 Project workspace；根目录填 .">
            <Input
              autoFocus
              value={directory}
              placeholder=". 或 packages/server"
              onChange={(event) => setDirectory(event.currentTarget.value)}
            />
          </FieldLabel>
        )}

        {source === "custom" && (
          <FieldLabel label="项目提示词" hint={`${content.length.toLocaleString()} / 32,768`}>
            <Textarea
              autoFocus
              className="min-h-48"
              maxLength={32_768}
              value={content}
              placeholder="描述项目约束、工作方式和需要长期遵循的规则…"
              onChange={(event) => setContent(event.currentTarget.value)}
            />
          </FieldLabel>
        )}

        {!workspace && source !== "custom" && source !== "none" && (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-800 ring-1 ring-amber-200">
            配置可以先保存；Agent 运行前仍需要绑定 Runner 与 workspace。
          </p>
        )}
        {Boolean(error) && (
          <p role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700">
            保存失败：{errorMessage(error)}
          </p>
        )}
        <p className="text-xs leading-5 text-slate-500">
          文件配置保存时不访问 Runner。Agent 创建运行时才会探测和读取，文件变更将在下次重建运行时后生效。
        </p>
        <div className="flex justify-end gap-3">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" disabled={!canSave} onClick={() => void submit().catch(() => {})}>
            {saving ? "保存中…" : "保存指令"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function SourceOption({
  active,
  icon,
  title,
  description,
  disabled = false,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xl p-3 text-left ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-45 ${
        active
          ? "bg-indigo-50 text-indigo-950 ring-indigo-300"
          : "bg-white text-slate-800 ring-slate-200 hover:bg-slate-50"
      }`}
    >
      <span className="flex items-center gap-2 font-medium">
        {icon}
        {title}
      </span>
      <span className="mt-1 block text-xs text-slate-500">{description}</span>
    </button>
  );
}
