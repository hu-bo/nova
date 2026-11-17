import { BrainCircuit, ChevronDown, CircleStop, Cpu, LoaderCircle, Puzzle, Send, X } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { ComposerContextUsageIndicator } from "./composer-context-usage.js";
import { ComposerOptionMenu } from "./composer-option-menu.js";
import { ComposerSkillMenu, findSkillMention, matchComposerSkills } from "./composer-skill-menu.js";
import type { ComposerProps, ComposerSkill, ComposerSubmission } from "./composer-types.js";
import { Textarea } from "./components/ui/textarea.js";
import { UploadCover } from "./upload-cover.js";

/**
 * Reads the capability signal published by `styles.css`. Must not be replaced with
 * `CSS.supports("field-sizing", "content")`: that reports engine support even when a build-time CSS
 * transform drops the rule, which would leave the field pinned to its fixed row height.
 */
function growsWithNativeLayout(element: HTMLElement): boolean {
  return getComputedStyle(element).getPropertyValue("--nova-composer-field-sizing").trim() === "content";
}

export function Composer<TMetadata = unknown>({
  initialText,
  value,
  onTextChange,
  onFilesSelected,
  disabled = false,
  submitDisabled = false,
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
  skills = [],
  onSkillInvoke,
  productSkills = [],
  selectedProductSkill,
  onProductSkillChange,
  contextUsage,
  accept,
  attachments = [],
  onAttachmentsChange,
  onAttachmentButtonClick,
  toolbarStart,
  toolbarEnd,
  headerContent,
  onSubmit,
}: ComposerProps<TMetadata>) {
  const [localText, setLocalText] = useState(initialText ?? "");
  const text = value ?? localText;
  function setText(next: string) {
    if (value === undefined) setLocalText(next);
    onTextChange?.(next);
  }
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [invokingSkill, setInvokingSkill] = useState(false);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const [productSkillMenuOpen, setProductSkillMenuOpen] = useState(false);
  const [cursor, setCursor] = useState(text.length);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const maxHeightRef = useRef<number | null>(null);
  const growsNativelyRef = useRef<boolean | null>(null);
  const isCappedRef = useRef(false);
  const appliedHeightRef = useRef<string | null>(null);
  const previousLengthRef = useRef(0);
  const skillListId = useId();
  const locked = disabled || submitting || invokingSkill;
  const mention = findSkillMention(text, cursor);
  const showProductSkills =
    !locked &&
    !skillMenuDismissed &&
    Boolean(onProductSkillChange) &&
    productSkills.length > 0 &&
    (productSkillMenuOpen || mention !== null);
  const matchingSkills = skillMenuDismissed || locked ? [] : matchComposerSkills(text, skills);
  const matchingProductSkills: ComposerSkill[] = productSkills
    .filter(
      (skill) =>
        !mention ||
        productSkillMenuOpen ||
        [skill.name, skill.description, skill.id].some((value) => value.toLocaleLowerCase().includes(mention.query)),
    )
    .map((skill) => ({
      id: `${skill.id}@${skill.version}`,
      command: skill.id,
      label: skill.name,
      description: skill.description,
    }));
  const menuSkills = showProductSkills ? matchingProductSkills : matchingSkills;
  const selectedSkill = menuSkills[Math.min(selectedSkillIndex, Math.max(0, menuSkills.length - 1))];
  const menuOpen = showProductSkills || matchingSkills.length > 0;
  const hasDraft = Boolean(text.trim() || files.length || attachments.length);
  const canSubmit = !locked && !submitDisabled && hasDraft;
  const activeProductSkill = productSkills.find(
    (skill) => skill.id === selectedProductSkill?.id && skill.version === selectedProductSkill.version,
  );

  // Grow the field in the layout engine wherever the stylesheet managed to apply
  // `field-sizing: content`; measuring here would dirty style and then read layout on every key.
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    if (growsNativelyRef.current === null) growsNativelyRef.current = growsWithNativeLayout(textarea);
    if (growsNativelyRef.current) return;

    if (maxHeightRef.current === null) {
      maxHeightRef.current = Number.parseFloat(getComputedStyle(textarea).maxHeight) || Number.POSITIVE_INFINITY;
    }
    const maxHeight = maxHeightRef.current;
    const previousLength = previousLengthRef.current;
    previousLengthRef.current = text.length;

    // A capped field scrolls its own overflow, so adding characters cannot change its box size.
    // Skipping the measurement here is what keeps long drafts from reflowing on every key.
    if (isCappedRef.current && text.length >= previousLength) return;

    // A fixed box floors `scrollHeight` at its own height, so release it before measuring.
    textarea.style.height = "auto";
    textarea.style.overflowY = "hidden";
    const contentHeight = textarea.scrollHeight;
    const nextHeight = `${Math.min(contentHeight, maxHeight)}px`;
    isCappedRef.current = contentHeight > maxHeight;
    if (isCappedRef.current) textarea.style.overflowY = "auto";
    if (appliedHeightRef.current !== nextHeight) {
      textarea.style.height = nextHeight;
      appliedHeightRef.current = nextHeight;
    }
  }, [text]);

  function clearDraft() {
    setText("");
    setFiles([]);
    onAttachmentsChange?.([]);
  }

  function restoreDraft(draft: ComposerSubmission<TMetadata>) {
    setText(draft.text);
    setFiles(draft.files);
    onAttachmentsChange?.(draft.attachments);
  }

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (!canSubmit) return;
    const draft = { text: text.trim(), files, attachments: [...attachments], model, reasoningEffort };
    const result = onSubmit(draft);
    if (result instanceof Promise) {
      setSubmitting(true);
      void result
        .then((accepted) => {
          if (accepted !== false) clearDraft();
        })
        .catch(() => restoreDraft(draft))
        .finally(() => setSubmitting(false));
    } else if (result !== false) {
      clearDraft();
    }
  }

  function invokeSkill(skill: ComposerSkill) {
    if (locked || skill.disabled || !onSkillInvoke) return;
    const commandDraft = text;
    setText("");
    setInvokingSkill(true);
    let result: void | Promise<void>;
    try {
      result = onSkillInvoke(skill);
    } catch {
      setText(commandDraft);
      setInvokingSkill(false);
      return;
    }
    Promise.resolve(result)
      .catch(() => setText(commandDraft))
      .finally(() => setInvokingSkill(false));
  }

  function selectProductSkill(item: ComposerSkill) {
    const skill = productSkills.find((candidate) => `${candidate.id}@${candidate.version}` === item.id);
    if (locked || !skill || !onProductSkillChange) return;
    if (mention) {
      setText(text.slice(0, mention.start) + text.slice(mention.end));
      setCursor(mention.start);
    }
    onProductSkillChange({ id: skill.id, version: skill.version });
    setProductSkillMenuOpen(false);
    setSkillMenuDismissed(true);
    textareaRef.current?.focus();
    if (mention) {
      requestAnimationFrame(() => textareaRef.current?.setSelectionRange(mention.start, mention.start));
    }
  }

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (menuOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        if (menuSkills.length > 0)
          setSelectedSkillIndex((current) => (current + direction + menuSkills.length) % menuSkills.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillMenuDismissed(true);
        setProductSkillMenuOpen(false);
        return;
      }
      if (!event.shiftKey && (event.key === "Enter" || (event.key === "Tab" && selectedSkill))) {
        event.preventDefault();
        if (selectedSkill) {
          if (showProductSkills) selectProductSkill(selectedSkill);
          else invokeSkill(selectedSkill);
        }
        return;
      }
    }
    if (event.key === "Escape" && isRunning && onAbort) {
      event.preventDefault();
      void onAbort();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Card
      className="nova-composer nova-chat-content relative overflow-visible rounded-2xl"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setSkillMenuDismissed(true);
          setProductSkillMenuOpen(false);
        }
      }}
    >
      <UploadCover
        files={files}
        onFilesChange={(next) => {
          if (onFilesSelected) onFilesSelected(next);
          else setFiles(next);
        }}
        attachments={attachments}
        onAttachmentsChange={onAttachmentsChange}
        onAttachmentButtonClick={onAttachmentButtonClick}
        allowFiles={allowFiles}
        disabled={locked}
        accept={accept}
      >
        {({ onPaste, trigger }) => (
          <form className="p-1.5" onSubmit={submit}>
            {headerContent}
            {selectedProductSkill && (
              <div className="px-2 pt-1.5">
                <button
                  type="button"
                  disabled={locked}
                  aria-label="移除技能"
                  className="inline-flex max-w-full items-center gap-1.5 rounded-lg bg-indigo-50 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-200"
                  onClick={() => {
                    onProductSkillChange?.(null);
                    textareaRef.current?.focus();
                  }}
                >
                  <Puzzle className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{activeProductSkill?.name ?? selectedProductSkill.id}</span>
                  <X className="size-3 shrink-0" aria-hidden="true" />
                </button>
              </div>
            )}
            <label className="block px-2">
              <span className="sr-only">消息</span>
              <Textarea
                ref={textareaRef}
                value={text}
                disabled={locked}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setCursor(event.currentTarget.selectionStart);
                  setSelectedSkillIndex(0);
                  setSkillMenuDismissed(false);
                  setProductSkillMenuOpen(false);
                }}
                onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
                onKeyDown={keyDown}
                onPaste={allowFiles ? onPaste : undefined}
                rows={2}
                placeholder={placeholder}
                className="nova-composer-textarea nova-scrollbar min-h-16 max-h-[204px] resize-none border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
                aria-expanded={menuOpen}
                aria-controls={menuOpen ? skillListId : undefined}
                aria-activedescendant={selectedSkill ? `${skillListId}-${selectedSkill.id}` : undefined}
              />
            </label>

            {menuOpen && (
              <ComposerSkillMenu
                listId={skillListId}
                skills={menuSkills}
                selected={selectedSkill}
                trigger={showProductSkills ? "@" : "/"}
                onSelect={showProductSkills ? selectProductSkill : onSkillInvoke && invokeSkill}
              />
            )}

            <div className="nova-composer-input-row flex min-w-0 items-center justify-between gap-2  border-slate-100 pt-1.5 dark:border-slate-800/80">
              <div className="nova-composer-options flex min-w-0 flex-wrap items-center gap-1">
                {trigger}
                {productSkills.length > 0 && onProductSkillChange && (
                  <button
                    type="button"
                    disabled={locked}
                    aria-label="选择技能"
                    aria-haspopup="listbox"
                    aria-expanded={showProductSkills}
                    aria-controls={showProductSkills ? skillListId : undefined}
                    className="nova-composer-option-trigger"
                    onClick={() => {
                      setProductSkillMenuOpen(!showProductSkills);
                      setSkillMenuDismissed(showProductSkills);
                      setSelectedSkillIndex(0);
                      textareaRef.current?.focus();
                    }}
                  >
                    <Puzzle className="size-3.5 shrink-0" aria-hidden="true" />
                    <span>技能</span>
                    <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                  </button>
                )}
                {toolbarStart}
                {!toolbarEnd && models.length > 0 && (
                  <ComposerOptionMenu
                    label="选择模型"
                    value={model}
                    options={models}
                    disabled={locked}
                    onChange={onModelChange}
                    icon={<Cpu className="size-3.5 shrink-0" aria-hidden="true" />}
                  />
                )}
                {!toolbarEnd && reasoningEfforts.length > 0 && (
                  <ComposerOptionMenu
                    label="选择推理强度"
                    value={reasoningEffort}
                    options={reasoningEfforts}
                    disabled={locked}
                    onChange={onReasoningEffortChange}
                    icon={<BrainCircuit className="size-3.5 shrink-0" aria-hidden="true" />}
                  />
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {toolbarEnd}
                {contextUsage && <ComposerContextUsageIndicator usage={contextUsage} />}
                {isRunning && onAbort && !hasDraft && !submitting ? (
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
                    disabled={!canSubmit || submitting}
                    aria-label={submitting ? "正在发送" : "发送消息"}
                    className="rounded-xl"
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
            </div>
          </form>
        )}
      </UploadCover>
    </Card>
  );
}
