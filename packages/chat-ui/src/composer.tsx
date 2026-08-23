import { BrainCircuit, ChevronDown, Cpu, FileText, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import {
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";

export interface ComposerOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export interface ComposerSubmission {
  text: string;
  files: File[];
  model?: string | undefined;
  reasoningEffort?: string | undefined;
}

export interface ComposerProps {
  disabled?: boolean | undefined;
  allowFiles?: boolean | undefined;
  placeholder?: string | undefined;
  models?: readonly ComposerOption[] | undefined;
  model?: string | undefined;
  onModelChange?: ((model: string) => void) | undefined;
  reasoningEfforts?: readonly ComposerOption[] | undefined;
  reasoningEffort?: string | undefined;
  onReasoningEffortChange?: ((effort: string) => void) | undefined;
  accept?: string | undefined;
  onSubmit: (submission: ComposerSubmission) => void | boolean | Promise<void | boolean>;
}

function OptionMenu({ label, value, options, disabled, icon, onChange }: {
  label: string;
  value?: string | undefined;
  options: readonly ComposerOption[];
  disabled: boolean;
  icon: ReactNode;
  onChange?: ((value: string) => void) | undefined;
}) {
  const selected = options.find(option => option.value === value);
  return (
    <DropdownMenu disabled={disabled || !onChange}>
      <DropdownMenuTrigger aria-label={label} className="inline-flex h-8 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-slate-500 outline-none transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:ring-3 focus-visible:ring-indigo-500/20 disabled:pointer-events-none disabled:opacity-40 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-100">
        {icon}<span className="truncate">{selected?.label ?? label}</span><ChevronDown className="size-3 shrink-0 opacity-60" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuRadioGroup value={value} onValueChange={next => onChange?.(String(next))}>
          {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}>{option.label}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Composer({
  disabled = false,
  allowFiles = true,
  placeholder = "输入消息或粘贴截图，Shift+Enter 换行",
  models = [],
  model,
  onModelChange,
  reasoningEfforts = [],
  reasoningEffort,
  onReasoningEffortChange,
  accept,
  onSubmit,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const locked = disabled || submitting;
  const canSubmit = !locked && Boolean(text.trim() || files.length);

  function clearDraft() {
    setText("");
    setFiles([]);
    if (fileInput.current) fileInput.current.value = "";
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;
    const result = onSubmit({ text: text.trim(), files, model, reasoningEffort });
    if (result instanceof Promise) {
      setSubmitting(true);
      void result.then(accepted => {
        if (accepted !== false) clearDraft();
      }).catch(() => undefined).finally(() => setSubmitting(false));
    } else if (result !== false) {
      clearDraft();
    }
  }

  function addFiles(incoming: Iterable<File>) {
    const added = Array.from(incoming);
    if (added.length) setFiles(current => [...current, ...added].slice(0, 10));
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const itemImages = Array.from(event.clipboardData.items)
      .filter(item => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap(item => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    const images = itemImages.length ? itemImages : Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Card className="nova-composer overflow-hidden rounded-2xl">
    <form className="p-1.5" onSubmit={submit}>
      {files.length > 0 && (
        <ul aria-label="待发送附件" className="nova-composer-attachments flex list-none flex-wrap gap-1.5 px-1 pb-1.5 pt-1">
          {files.map((file, index) => (
            <li key={`${file.name}-${file.lastModified}-${index}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-slate-50 py-1.5 pl-2.5 pr-1 text-xs text-slate-600 ring-1 ring-slate-200/70 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800">
              <FileText className="size-3.5 shrink-0 text-indigo-500" aria-hidden="true" />
              <span className="truncate">{file.name}</span>
              <Button type="button" variant="ghost" size="icon-xs" disabled={locked} aria-label={`移除 ${file.name}`} onClick={() => setFiles(current => current.filter((_, itemIndex) => itemIndex !== index))}><X aria-hidden="true" /></Button>
            </li>
          ))}
        </ul>
      )}

      <label className="block px-2">
        <span className="sr-only">消息</span>
        <Textarea
          value={text}
          disabled={locked}
          onChange={event => setText(event.currentTarget.value)}
          onKeyDown={keyDown}
          onPaste={allowFiles ? paste : undefined}
          rows={2}
          placeholder={placeholder}
          className="min-h-16 resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
        />
      </label>

      <div className="nova-composer-input-row flex min-w-0 items-center justify-between gap-2 border-t border-slate-100 pt-1.5 dark:border-slate-800/80">
        <div className="nova-composer-options flex min-w-0 flex-wrap items-center gap-1">
          <input ref={fileInput} type="file" multiple accept={accept} disabled={locked || !allowFiles} onChange={chooseFiles} className="hidden" />
          {allowFiles && <TooltipProvider><Tooltip><TooltipTrigger render={<Button type="button" variant="ghost" size="icon-sm" disabled={locked} onClick={() => fileInput.current?.click()} aria-label="添加文件" />}><Paperclip aria-hidden="true" /></TooltipTrigger><TooltipContent>添加文件或粘贴截图</TooltipContent></Tooltip></TooltipProvider>}
          {models.length > 0 && <OptionMenu label="选择模型" value={model} options={models} disabled={locked} onChange={onModelChange} icon={<Cpu className="size-3.5 shrink-0" aria-hidden="true" />} />}
          {reasoningEfforts.length > 0 && <OptionMenu label="选择推理强度" value={reasoningEffort} options={reasoningEfforts} disabled={locked} onChange={onReasoningEffortChange} icon={<BrainCircuit className="size-3.5 shrink-0" aria-hidden="true" />} />}
        </div>

        <Button type="submit" variant="primary" size="icon" disabled={!canSubmit} aria-label={submitting ? "正在发送" : "发送消息"} className="rounded-xl bg-gradient-to-br from-indigo-500 via-indigo-600 to-violet-600 shadow-md shadow-indigo-500/20">
          {submitting ? <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Send className="size-4 transition-transform group-hover:translate-x-px group-hover:-translate-y-px" aria-hidden="true" />}
        </Button>
      </div>
    </form>
    </Card>
  );
}
