import type { ReactNode } from "react";
import type {
  AgentProfile,
  ProductSkill,
  SkillApplicability,
  SkillSelection,
  SkillUnavailability,
} from "@nova/agent-ui-contracts";
import type { UploadAttachment } from "./upload-cover.js";

export interface ComposerOption {
  value: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
}

export interface ComposerSkill {
  id: string;
  command: string;
  label: string;
  description?: string | undefined;
  disabled?: boolean | undefined;
  icon?: ReactNode | undefined;
  /** 一行来源标签（技能/Agent 条目的来源显示）；文案由调用方给出。 */
  meta?: string | undefined;
  /** 附加说明行（服务端不适用/不兼容原因文案），逐行展示，不做客户端枚举映射。 */
  notes?: readonly string[] | undefined;
}

/** 技能选择条目：目录摘要 + 服务端适用性；只作展示，选择与准入判断留在服务端。 */
export interface ComposerProductSkill extends ProductSkill {
  applicability?: SkillApplicability | undefined;
  disabled?: boolean | undefined;
}

/** Agent 目录条目（GET /api/agents）：独立于技能的选择面；incompatibilities 非空则不可选。 */
export interface ComposerAgentEntry {
  refId: string;
  name: string;
  description: string;
  source: ComposerAgentSelection["source"];
  version: string;
  incompatibilities?: readonly SkillUnavailability[] | undefined;
}

/** configuration.agentProfile 的引用分支形状（本地/平台 Agent），不是 chat 常量。 */
export type ComposerAgentSelection = Extract<AgentProfile, { refId: string }>;

export interface ComposerContextUsage {
  estimatedInputTokens: number;
  maxInputTokens: number;
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
  toolbarStart?: ReactNode | undefined;
  toolbarEnd?: ReactNode | undefined;
  headerContent?: ReactNode | undefined;
  submitDisabled?: boolean | undefined;
  initialText?: string | undefined;
  value?: string | undefined;
  onTextChange?: ((text: string) => void) | undefined;
  onFilesSelected?: ((files: File[]) => void) | undefined;
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
  productSkills?: readonly ComposerProductSkill[] | undefined;
  selectedProductSkill?: SkillSelection | null | undefined;
  onProductSkillChange?: ((skill: SkillSelection | null) => void) | undefined;
  agents?: readonly ComposerAgentEntry[] | undefined;
  selectedAgent?: ComposerAgentSelection | null | undefined;
  onAgentChange?: ((agent: ComposerAgentSelection | null) => void) | undefined;
  onSkillInvoke?: ((skill: ComposerSkill) => void | Promise<void>) | undefined;
  contextUsage?: ComposerContextUsage | undefined;
  accept?: string | undefined;
  attachments?: readonly ComposerAttachment<TMetadata>[] | undefined;
  onAttachmentsChange?: ((attachments: ComposerAttachment<TMetadata>[]) => void) | undefined;
  onAttachmentButtonClick?: (() => void | Promise<void>) | undefined;
  onSubmit: (submission: ComposerSubmission<TMetadata>) => void | boolean | Promise<void | boolean>;
}
