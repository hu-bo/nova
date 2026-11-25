import { FileText, Paperclip, X } from "lucide-react";
import { useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { Button } from "./components/ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";

export interface UploadAttachment<TMetadata = unknown> {
  id: string;
  name: string;
  metadata: TMetadata;
  description?: string | undefined;
}

/** paste 事件里同步可读的剪贴板数据；`DataTransfer` 结构上满足此形状。 */
export interface ClipboardDataFiles {
  items: ArrayLike<{ kind: string; type: string; getAsFile: () => File | null }>;
  files: ArrayLike<File>;
}

/** Async Clipboard API 的可读图片来源（仅 HTTPS / localhost 暴露）；只声明用到的成员。 */
export interface ReadableClipboardImages {
  read?: () => Promise<readonly { types: readonly string[]; getType: (type: string) => Promise<Blob> }[]>;
}

/** 同步提取剪贴板携带的图片文件：优先 `items`，取不到时退回 `files`（部分应用的复制行为只填后者）。 */
export function collectClipboardImages(clipboard: ClipboardDataFiles): File[] {
  const fromItems = Array.from(clipboard.items)
    .filter((item) => item.type.startsWith("image/"))
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [file] : [];
    });
  if (fromItems.length) return fromItems;
  return Array.from(clipboard.files).filter((file) => file.type.startsWith("image/"));
}

/**
 * 经 Async Clipboard API 读取剪贴板图片，覆盖不进入 paste 事件的图片来源。
 * 不支持、无权限或被拒绝时返回空数组，调用方按普通粘贴处理。
 */
export async function readClipboardImages(clipboard: ReadableClipboardImages | undefined): Promise<File[]> {
  if (!clipboard?.read) return [];
  let entries: Awaited<ReturnType<NonNullable<ReadableClipboardImages["read"]>>>;
  try {
    entries = await clipboard.read();
  } catch {
    return [];
  }
  const files: File[] = [];
  for (const entry of entries) {
    const type = entry.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await entry.getType(type);
    const extension = type.slice("image/".length).split("+")[0];
    files.push(new File([blob], `pasted-${Date.now()}.${extension}`, { type }));
  }
  return files;
}

export interface UploadCoverControls {
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  trigger: ReactNode;
}

export interface UploadCoverProps<TMetadata = unknown> {
  files: readonly File[];
  onFilesChange: (files: File[]) => void;
  attachments?: readonly UploadAttachment<TMetadata>[] | undefined;
  onAttachmentsChange?: ((attachments: UploadAttachment<TMetadata>[]) => void) | undefined;
  onAttachmentButtonClick?: (() => void | Promise<void>) | undefined;
  allowFiles?: boolean | undefined;
  disabled?: boolean | undefined;
  accept?: string | undefined;
  maxFiles?: number | undefined;
  children: (controls: UploadCoverControls) => ReactNode;
}

export function UploadCover<TMetadata = unknown>({
  files,
  onFilesChange,
  attachments = [],
  onAttachmentsChange,
  onAttachmentButtonClick,
  allowFiles = true,
  disabled = false,
  accept,
  maxFiles = 10,
  children,
}: UploadCoverProps<TMetadata>) {
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  function addFiles(incoming: Iterable<File>) {
    const added = Array.from(incoming);
    if (added.length) onFilesChange([...files, ...added].slice(0, maxFiles));
  }

  function chooseFiles(event: ChangeEvent<HTMLInputElement>) {
    if (event.currentTarget.files) addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  }

  function hasDraggedFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  function dragEnter(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    if (disabled || !allowFiles) return;
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function dragOver(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = disabled || !allowFiles ? "none" : "copy";
  }

  function dragLeave(event: DragEvent<HTMLDivElement>) {
    if (!dragDepth.current) return;
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDraggingFiles(false);
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (disabled || !allowFiles) return;
    addFiles(event.dataTransfer.files);
  }

  function paste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (disabled || !allowFiles) return;
    const images = collectClipboardImages(event.clipboardData);
    if (images.length) {
      event.preventDefault();
      addFiles(images);
      return;
    }
    const clipboardTypes = Array.from(event.clipboardData.types);
    const hasImagePayload =
      clipboardTypes.includes("Files") ||
      clipboardTypes.some((type) => type.startsWith("image/")) ||
      Array.from(event.clipboardData.items).some((item) => item.type.startsWith("image/"));
    // 一些应用会同时声明文本和图片格式；图片无法同步读取时优先尝试图片兜底。
    if (!hasImagePayload && clipboardTypes.some((type) => type.startsWith("text/"))) return;
    // 某些应用复制的图片不出现在 paste 事件里；默认粘贴本来插不进内容，
    // 拦下事件改走 Async Clipboard API（HTTPS / localhost 可用，其余环境返回空即无操作）。
    event.preventDefault();
    void readClipboardImages(globalThis.navigator?.clipboard).then((files) => {
      if (files.length) addFiles(files);
    });
  }

  const trigger =
    allowFiles || onAttachmentButtonClick ? (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                onClick={() => {
                  if (onAttachmentButtonClick) void onAttachmentButtonClick();
                  else fileInput.current?.click();
                }}
                aria-label={onAttachmentButtonClick ? "添加附件" : "添加文件"}
              />
            }
          >
            <Paperclip aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent>{onAttachmentButtonClick ? "添加附件" : "添加文件或粘贴截图"}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    ) : null;

  return (
    <div className="relative" onDragEnter={dragEnter} onDragOver={dragOver} onDragLeave={dragLeave} onDrop={drop}>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={accept}
        disabled={disabled || !allowFiles}
        onChange={chooseFiles}
        className="hidden"
      />

      {(files.length > 0 || attachments.length > 0) && (
        <ul
          aria-label="待发送附件"
          className="nova-composer-attachments flex list-none flex-wrap gap-1.5 px-1 pb-1.5 pt-1"
        >
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.lastModified}-${index}`}
              className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-slate-50 py-1.5 pl-2.5 pr-1 text-xs text-slate-600 ring-1 ring-slate-200/70 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800"
            >
              <FileText className="size-3.5 shrink-0 text-indigo-500" aria-hidden="true" />
              <span className="truncate">{file.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled}
                aria-label={`移除 ${file.name}`}
                onClick={() => onFilesChange(files.filter((_, itemIndex) => itemIndex !== index))}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-indigo-50 py-1.5 pl-2.5 pr-1 text-xs text-indigo-700 ring-1 ring-indigo-200/70 dark:bg-indigo-950/50 dark:text-indigo-200 dark:ring-indigo-900"
              title={attachment.description}
            >
              <FileText className="size-3.5 shrink-0 text-indigo-500" aria-hidden="true" />
              <span className="truncate">{attachment.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={disabled || !onAttachmentsChange}
                aria-label={`移除 ${attachment.name}`}
                onClick={() => onAttachmentsChange?.(attachments.filter((item) => item.id !== attachment.id))}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {draggingFiles && (
        <div
          className="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-xl border-2 border-dashed border-indigo-400 bg-indigo-50/95 text-sm font-medium text-indigo-700 dark:bg-indigo-950/95 dark:text-indigo-200"
          role="status"
        >
          松开以上传文件
        </div>
      )}

      {children({ onPaste: paste, trigger })}
    </div>
  );
}
