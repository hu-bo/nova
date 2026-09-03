import { BrainCircuit, CircleStop, Cpu, LoaderCircle, Send } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Button } from "./components/ui/button.js";
import { Card } from "./components/ui/card.js";
import { ComposerContextUsageIndicator } from "./composer-context-usage.js";
import { ComposerOptionMenu } from "./composer-option-menu.js";
import { ComposerSkillMenu, matchComposerSkills } from "./composer-skill-menu.js";
import type { ComposerProps, ComposerSkill, ComposerSubmission } from "./composer-types.js";
import { Textarea } from "./components/ui/textarea.js";
import { UploadCover } from "./upload-cover.js";

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
  skills = [],
  onSkillInvoke,
  contextUsage,
  accept,
  attachments = [],
  onAttachmentsChange,
  onAttachmentButtonClick,
  onSubmit,
}: ComposerProps<TMetadata>) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [invokingSkill, setInvokingSkill] = useState(false);
  const [selectedSkillIndex, setSelectedSkillIndex] = useState(0);
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skillListId = useId();
  const locked = disabled || submitting || invokingSkill;
  const matchingSkills = skillMenuDismissed ? [] : matchComposerSkills(text, skills);
  const selectedSkill = matchingSkills[Math.min(selectedSkillIndex, Math.max(0, matchingSkills.length - 1))];
  const hasDraft = Boolean(text.trim() || files.length || attachments.length);
  const canSubmit = !locked && hasDraft;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const maxHeight = Number.parseFloat(getComputedStyle(textarea).maxHeight);
    textarea.style.height = `${Math.min(textarea.scrollHeight, maxHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
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
      clearDraft();
      void result
        .then((accepted) => {
          if (accepted === false) restoreDraft(draft);
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

  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Escape" && isRunning && onAbort) {
      event.preventDefault();
      void onAbort();
      return;
    }
    if (matchingSkills.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        setSelectedSkillIndex((current) => (current + direction + matchingSkills.length) % matchingSkills.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSkillMenuDismissed(true);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && selectedSkill) {
        event.preventDefault();
        invokeSkill(selectedSkill);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Card className="nova-composer nova-chat-content overflow-visible rounded-2xl">
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
                ref={textareaRef}
                value={text}
                disabled={locked}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setSelectedSkillIndex(0);
                  setSkillMenuDismissed(false);
                }}
                onKeyDown={keyDown}
                onPaste={allowFiles ? onPaste : undefined}
                rows={2}
                placeholder={placeholder}
                className="min-h-16 max-h-[204px] resize-none overflow-y-hidden border-0 bg-transparent px-0 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
                aria-expanded={matchingSkills.length > 0}
                aria-controls={matchingSkills.length > 0 ? skillListId : undefined}
                aria-activedescendant={selectedSkill ? `${skillListId}-${selectedSkill.id}` : undefined}
              />
            </label>

            <ComposerSkillMenu
              listId={skillListId}
              skills={matchingSkills}
              selected={selectedSkill}
              onSelect={onSkillInvoke ? invokeSkill : undefined}
            />

            <div className="nova-composer-input-row flex min-w-0 items-center justify-between gap-2  border-slate-100 pt-1.5 dark:border-slate-800/80">
              <div className="nova-composer-options flex min-w-0 flex-wrap items-center gap-1">
                {trigger}
                {models.length > 0 && (
                  <ComposerOptionMenu
                    label="选择模型"
                    value={model}
                    options={models}
                    disabled={locked}
                    onChange={onModelChange}
                    icon={<Cpu className="size-3.5 shrink-0" aria-hidden="true" />}
                  />
                )}
                {reasoningEfforts.length > 0 && (
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
            </div>
          </form>
        )}
      </UploadCover>
    </Card>
  );
}
