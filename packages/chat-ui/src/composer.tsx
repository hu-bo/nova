import { BrainCircuit, ChevronDown, CircleStop, Cpu, LoaderCircle, Send } from "lucide-react";
import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { Textarea } from "./components/ui/textarea.js";
import { UploadCover, type UploadAttachment } from "./upload-cover.js";

export interface ComposerOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export type ComposerAttachment<TMetadata = unknown> = UploadAttachment<TMetadata>;

export interface ComposerSubmission<TMetadata = unknown> {
  text: string;
  files: File[];
  attachments: ComposerAttachment<TMetadata>[];
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}

export interface ComposerProps<TMetadata = unknown> {
  disabled?: boolean | undefined;
  isRunning?: boolean | undefined;
  isAborting?: boolean | undefined;
  onAbort?: (() => void | Promise<void>) | undefined;
  allowFiles?: boolean | undefined;
  placeholder?: string | undefined;
  models?: readonly ComposerOption[] | undefined;
  model?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  reasoningEfforts?: readonly ComposerOption[] | undefined;
  reasoningEffort?: string | undefined;
  onReasoningEffortChange?: ((effort: string) => void) | undefined;
  accept?: string | undefined;
  attachments?: readonly ComposerAttachment<TMetadata>[] | undefined;
  onAttachmentsChange?: ((attachments: ComposerAttachment<TMetadata>[]) => void) | undefined;
  onAttachmentButtonClick?: (() => void | Promise<void>) | undefined;
  onSubmit: (submission: ComposerSubmission<TMetadata>) => void | boolean | Promise<void | boolean>;
}

function OptionMenu({
  label,
  value,
  options,
  disabled,
  icon,
  onChange,
}: {
  label: string;
  value?: string | undefined;
  options: readonly ComposerOption[];
  disabled: boolean;
  icon: ReactNode;
  onChange?: ((value: string) => void) | undefined;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu disabled={disabled || !onChange}>
      <DropdownMenuTrigger
        aria-label={label}
        className="inline-flex h-8 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-3 focus-visible:ring-indigo-500/20 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      >
        {icon}
        <span className="truncate">{selected?.label ?? label}</span>
        <ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange?.(String(next))}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer<TMetadata = unknown>({
  disabled = false,
  isRunning = false,
  isAborting = false,
  onAbort,
  allowFiles = true,
  placeholder = "输入消息或粘贴截图，Shift+Enter 换行",
  models = [],
  model,
  onModelChange,
  reasoningEfforts = [],
  reasoningEffort,
  onReasoningEffortChange,
  accept,
  attachments = [],
  onAttachmentsChange,
  onAttachmentButtonClick,
  onSubmit,
}: ComposerProps<TMetadata>) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const locked = disabled || submitting;
  const canSubmit = !locked && Boolean(text.trim() || files.length || attachments.length);

  function clearDraft() {
    setText("");
    setFiles([]);
    onAttachmentsChange?.([]);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;
    const result = onSubmit({ text: text.trim(), files, attachments: [...attachments], model, reasoningEffort });
    if (result instanceof Promise) {
      setSubmitting(true);
      void result
        .then((accepted) => {
          if (accepted !== false) clearDraft();
        })
        .catch(() => undefined)
        .finally(() => setSubmitting(false));
    } else if (result !== false) {
      clearDraft();
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Card className="nova-composer overflow-hidden rounded-2xl">
      <UploadCover
        files={files}
        onFilesChange={setFiles}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        onAttachmentButtonClick={onAttachmentButtonClick}
        allowFiles={allowFiles}
        disabled={locked}
        accept={accept}
      >
        {({ onPaste, trigger }) => (
          <form className="p-1.5" onSubmit={submit}>
            <label className="block px-2">
              <span className="sr-only">消息</span>
              <Textarea
                value={text}
                disabled={locked}
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={keyDown}
                onPaste={allowFiles ? onPaste : undefined}
                rows={2}
                placeholder={placeholder}
                className="min-h-16 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
              />
            </label>

            <div className="nova-composer-input-row flex min-w-0 items-center justify-between gap-2 border-t border-slate-100 pt-1.5 dark:border-slate-800/80">
              <div className="nova-composer-options flex min-w-0 flex-wrap items-center gap-1">
                {trigger}
                {models.length > 0 && (
                  <OptionMenu
                    label="选择模型"
                    value={model}
                    options={models}
                    disabled={locked}
                    onChange={onModelChange}
                    icon={<Cpu className="size-3.5 shrink-0" aria-hidden="true" />}
                  />
                )}
                {reasoningEfforts.length > 0 && (
                  <OptionMenu
                    label="选择推理强度"
                    value={reasoningEffort}
                    options={reasoningEfforts}
                    disabled={locked}
                    onChange={onReasoningEffortChange}
                    icon={<BrainCircuit className="size-3.5 shrink-0" aria-hidden="true" />}
                  />
                )}
              </div>

              {isRunning && onAbort ? (
                <Button
                  type="button"
                  variant="destructive"
                  size="icon"
                  disabled={isAborting}
                  aria-label={isAborting ? "正在中断" : "中断当前运行"}
                  onClick={() => void onAbort()}
                  className="rounded-xl"
                >
                  {isAborting ? (
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <CircleStop className="size-4" aria-hidden="true" />
                  )}
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="primary"
                  size="icon"
                  disabled={!canSubmit}
                  aria-label={submitting ? "正在发送" : "发送消息"}
                  className="rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 shadow-md shadow-indigo-500/20"
                >
                  {submitting ? (
                    <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : (
                    <Send
                      className="size-4 transition-transform group-hover:translate-x-px group-hover:-translate-y-px"
                      aria-hidden="true"
                    />
                  )}
                </Button>
              )}
            </div>
          </form>
        )}
      </UploadCover>
    </Card>
  );
}
