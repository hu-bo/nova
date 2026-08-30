import type { ReactNode } from "react";
import type { UploadAttachment } from "./upload-cover.js";

export interface ComposerOption {
  value: string;
  label: string;
  disabled?: boolean | undefined;
}

export interface ComposerSkill {
  id: string;
  command: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  icon?: ReactNode | undefined;
}

export interface ComposerContextUsage {
  inputTokens: number | null;
  contextWindow: number;
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
  skills?: readonly ComposerSkill[] | undefined;
  onSkillInvoke?: ((skill: ComposerSkill) => void | Promise<void>) | undefined;
  contextUsage?: ComposerContextUsage | undefined;
  accept?: string | undefined;
  attachments?: readonly ComposerAttachment<TMetadata>[] | undefined;
  onAttachmentsChange?: ((attachments: ComposerAttachment<TMetadata>[]) => void) | undefined;
  onAttachmentButtonClick?: (() => void | Promise<void>) | undefined;
  onSubmit: (submission: ComposerSubmission<TMetadata>) => void | boolean | Promise<void | boolean>;
}
