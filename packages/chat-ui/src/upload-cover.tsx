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
    const itemImages = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    const images = itemImages.length
      ? itemImages
      : Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    addFiles(images);
  }

  const trigger = allowFiles ? (
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
