import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ChatComposerConfig,
  ChatQueuedMessage,
  ComposerAttachment,
  ComposerSkill,
  ComposerSubmission,
  RemoteExplorerProps,
} from '@nova/chat-ui';
import { z } from 'zod';
import type { Attachment, Configuration, InputBlock, QueuedInput } from '@nova/agent-ui-contracts';
import { summariseRunnerFiles } from '@/api/generated/runners';
import { summariseRemoteFiles } from '@/api/generated/remotes';
import type {
  GetConversationSnapshot200,
  GetProjectBinding200,
} from '@/api/generated/projectsAPI.schemas';
import { ApiError } from '@/api/api-error';
import { useIdentity } from '@/features/auth';
import { useUploadQueue, IMAGE_ACCEPT } from '@/features/attachments';
import { loadRunnerDirectory } from '@/features/runners';
import {
  loadRemoteDirectory,
  relativeRemotePath,
  resolveRemotePath,
  useRemoteConnectionsQuery,
} from '@/features/remotes';
import { useClientConfig } from '@/features/models';
import { LocalStore } from '@/lib/local-store';
import { uuid } from '@/lib/uuid';
import { useModelSettings } from '@/features/settings';
import type { ModelThinkingLevel } from '@/features/settings';
import {
  useAppendPendingInputMutation,
  useCreateConversationMutation,
  useRemovePendingInputMutation,
  useSteerPendingInputMutation,
} from './conversation.queries';
import { readDraft, saveDraft } from './draft-storage';

type PendingInput = QueuedInput;
const LEGACY_MODEL_STORE = new LocalStore('nova_selected_model_profile', '');
const LEGACY_REASONING_STORE = new LocalStore('nova_selected_reasoning_effort', '');
const REASONING_LABELS: Record<string, string> = {
  off: '关闭',
  low: '低',
  medium: '中',
  high: '高',
  max: '最大',
};
type DraftOptions = {
  executionMode: 'build' | 'plan';
  specArmed?: boolean;
  goalArmed: boolean;
  maxIterations: number;
  acceptanceCriteria: string;
};
const summarySchema = z.array(
  z.object({
    path: z.string(),
    size: z.number().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    mtime: z.string().datetime(),
  }),
);
type SummaryItem = z.infer<typeof summarySchema>[number];

/** SSH 与 Runner 两种目录的差异点：展示名、引用与失败文案；流程本身只保留一份实现。 */
interface DirectoryAttachmentsSource {
  title: string;
  initialPath: string;
  selectedPaths: string[];
  loadDirectory: RemoteExplorerProps['loadDirectory'];
  summarise: (paths: string[]) => Promise<{ items: unknown }>;
  displayName: (item: SummaryItem) => string;
  describe?: (name: string) => string;
  makeRef: (item: SummaryItem) => Attachment['ref'];
  failureMessage: string;
}

/** 统一的「浏览目录 → 摘要校验 → 去重合并 → 关闭」附件选择流程；原先 SSH/Runner 两分支各写一遍。 */
function buildAttachmentsExplorer(
  source: DirectoryAttachmentsSource,
  state: {
    open: boolean;
    close: () => void;
    append: (files: ComposerAttachment<Attachment>[]) => void;
    fail: (error: unknown) => void;
  },
): RemoteExplorerProps {
  return {
    open: state.open,
    onClose: state.close,
    mode: 'file',
    multiple: true,
    title: source.title,
    initialPath: source.initialPath,
    selectedPaths: source.selectedPaths,
    loadDirectory: source.loadDirectory,
    onConfirm: async (entries) => {
      try {
        const result = await source.summarise(entries.map((entry) => entry.path));
        const verified = summarySchema.parse(result.items);
        state.append(
          verified.map((item): ComposerAttachment<Attachment> => {
            const name = source.displayName(item);
            return {
              id: uuid(),
              name,
              description: source.describe ? source.describe(name) : name,
              metadata: {
                ref: source.makeRef(item),
                name,
                mimeType: 'text/plain',
                size: item.size,
                sha256: item.sha256,
              },
            };
          }),
        );
        state.close();
      } catch (cause) {
        state.fail(cause);
        throw new Error(source.failureMessage, { cause });
      }
    },
  };
}

export interface ConversationComposerOptions {
  conversationId: string | null;
  mode: 'chat' | 'project';
  projectId?: string | undefined;
  specSession?: boolean;
  initialSpecMode?: boolean;
  startingSpec?: boolean;
  onStartSpec?: (input: { message: string; configuration: Configuration }) => Promise<void>;
  binding: GetProjectBinding200 | null;
  runtime?: Configuration | undefined;
  goal?: GetConversationSnapshot200['goal'] | undefined;
  isRunning: boolean;
  steeringEnabled?: boolean | undefined;
  pendingInputs: PendingInput[];
  contextUsage?: { estimatedInputTokens: number; maxInputTokens: number } | undefined;
  onCreated?: ((id: string) => void) | undefined;
  onClearContext?: (() => void) | undefined;
}

export function useConversationComposer(options: ConversationComposerOptions) {
  const {
    conversationId,
    mode,
    projectId,
    binding,
    runtime,
    isRunning,
    pendingInputs,
    contextUsage,
    onCreated,
    onClearContext,
  } = options;
  const { identity } = useIdentity();
  const config = useClientConfig();
  const modelSettings = useModelSettings();
  const remoteCatalog = useRemoteConnectionsQuery();
  const draftId = conversationId ?? 'new:' + mode + ':' + (projectId ?? '');
  const accountId = identity!.identityId;
  const modelStore = useMemo(
    () => new LocalStore('nova_selected_model_profile:' + accountId, LEGACY_MODEL_STORE.get()),
    [accountId],
  );
  const reasoningStore = useMemo(
    () =>
      new LocalStore('nova_selected_reasoning_effort:' + accountId, LEGACY_REASONING_STORE.get()),
    [accountId],
  );
  const optionStore = useMemo(
    () =>
      new LocalStore<DraftOptions | null>(
        'nova_composer_options:' + accountId + ':' + draftId,
        null,
      ),
    [accountId, draftId],
  );
  const [storedOptions] = useState(() => optionStore.get());
  const [text, setText] = useState(() => readDraft(accountId, draftId));
  const [executionMode, setExecutionMode] = useState<'build' | 'plan'>(
    storedOptions?.executionMode ?? runtime?.mode ?? 'build',
  );
  const [specArmed, setSpecArmed] = useState(options.initialSpecMode ?? storedOptions?.specArmed ?? false);
  const [goalArmed, setGoalArmed] = useState(storedOptions?.goalArmed ?? false);
  const [maxIterations, setMaxIterations] = useState(storedOptions?.maxIterations ?? 10);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(
    storedOptions?.acceptanceCriteria ?? '',
  );
  const [goalDialogOpen, setGoalDialogOpen] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(false);
  const [remote, setRemote] = useState<ComposerAttachment<Attachment>[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [unboundOpen, setUnboundOpen] = useState(false);
  const [steeringId, setSteeringId] = useState<string | null>(null);
  const create = useCreateConversationMutation();
  const append = useAppendPendingInputMutation(conversationId);
  const remove = useRemovePendingInputMutation(conversationId);
  const steer = useSteerPendingInputMutation(conversationId);
  const uploads = useUploadQueue();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const sending = create.isPending || append.isPending || modelSettings.saving || Boolean(options.startingSpec);
  const remoteConnectionId =
    mode === 'project' ? (binding?.remoteConnectionId ?? '') : (runtime?.remoteConnectionId ?? '');
  const selectedRemote = remoteCatalog.data?.items.find((entry) => entry.id === remoteConnectionId);
  const usesRemoteFiles = mode === 'project' || Boolean(remoteConnectionId);
  const ready = uploads.entries.flatMap((entry): ComposerAttachment<Attachment>[] =>
    entry.status === 'ready' && entry.attachment
      ? [
          {
            id: entry.id,
            name: entry.file.name,
            metadata: entry.attachment,
            description: '已上传并校验',
          },
        ]
      : [],
  );
  const attachments = usesRemoteFiles ? remote : ready;
  const blocked = !usesRemoteFiles && uploads.entries.some((entry) => entry.status !== 'ready');
  const [storedProfileId, setStoredProfileId] = useState(() =>
    runtime?.modelId ? 'server:' + runtime.modelId : modelStore.get(),
  );
  const [storedReasoning, setStoredReasoning] = useState(
    () => runtime?.reasoningEffort ?? reasoningStore.get(),
  );
  const modelProfileId = modelSettings.profiles.some((profile) => profile.id === storedProfileId)
    ? storedProfileId
    : modelSettings.profiles.some((profile) => profile.id === modelSettings.defaultProfileId)
      ? modelSettings.defaultProfileId
      : (modelSettings.profiles[0]?.id ?? '');
  const selectedProfile = modelSettings.profiles.find((profile) => profile.id === modelProfileId);
  const modelOptions = useMemo(
    () =>
      modelSettings.profiles.map((profile) => ({
        value: profile.id,
        label: profile.model + ' (' + profile.providerName + ')',
      })),
    [modelSettings.profiles],
  );
  const reasoningEfforts = useMemo(
    () =>
      (selectedProfile?.thinkingLevels ?? []).map((level) => ({
        value: level,
        label: REASONING_LABELS[level] ?? level,
      })),
    [selectedProfile?.thinkingLevels],
  );
  const reasoningEffort = reasoningEfforts.some((entry) => entry.value === storedReasoning)
    ? storedReasoning
    : (reasoningEfforts.find((entry) => entry.value === 'medium')?.value ??
      reasoningEfforts[0]?.value ??
      '');

  useEffect(() => {
    optionStore.set({
      executionMode,
      specArmed,
      goalArmed,
      maxIterations,
      acceptanceCriteria,
    });
  }, [optionStore, executionMode, specArmed, goalArmed, maxIterations, acceptanceCriteria]);
  useEffect(() => {
    if (runtime?.modelId) setStoredProfileId('server:' + runtime.modelId);
  }, [runtime?.modelId]);

  function changeText(value: string) {
    setText(value);
    saveDraft(accountId, draftId, value);
  }
  function changeModel(id: string) {
    modelStore.set(id);
    setStoredProfileId(id);
  }
  function changeReasoning(value: string) {
    reasoningStore.set(value);
    setStoredReasoning(value);
  }

  const skills = useMemo<ComposerSkill[]>(
    () => [
      {
        id: 'goal',
        command: 'goal',
        label: '设置目标',
        description: '把下一条消息作为目标，持续推进并记录完成标准',
      },
      {
        id: 'plan',
        command: 'plan',
        label: '切换 Plan 模式',
        description: '先分析和制定方案，不修改文件',
      },
      { id: 'build', command: 'build', label: '切换 Build 模式', description: '按任务推进实现' },
      ...(!conversationId ? [{ id: 'spec', command: 'spec', label: '切换 Spec 模式', description: '发送首条需求后打开规格工作台' }] : []),
      ...(conversationId
        ? [{ id: 'clear', command: 'clear', label: '清除上下文', disabled: isRunning }]
        : []),
    ].filter((skill) => !options.specSession || !['goal', 'build'].includes(skill.id)),
    [conversationId, isRunning, options.specSession],
  );

  async function submit(submission: ComposerSubmission<Attachment>): Promise<boolean> {
    setError(null);
    let message = submission.text.trim();
    let nextMode: Configuration['mode'] = options.specSession ? 'plan' : executionMode;
    let startsGoal = goalArmed;
    let startsSpec = !conversationId && specArmed;
    const command = /^\/(goal|plan|build|spec)(?:\s+|$)/.exec(message);
    if (command) {
      const name = command[1]!;
      message = message.slice(command[0].length).trim();
      if (name === 'spec' && conversationId) {
        setError(new ApiError(409, 'SPEC_NEW_CONVERSATION_REQUIRED', '请在新会话中选择 Spec 模式开始一份规格。'));
        return false;
      }
      if (name === 'spec' && !conversationId) {
        startsSpec = true; startsGoal = false;
        setSpecArmed(true); setGoalArmed(false);
      } else if (name === 'goal') {
        startsSpec = false; setSpecArmed(false);
        startsGoal = true;
        setGoalArmed(true);
      } else {
        startsSpec = false; setSpecArmed(false);
        nextMode = name === 'plan' ? 'plan' : 'build';
        setExecutionMode(nextMode);
      }
      if (!message) {
        changeText('');
        return false;
      }
    }
    if ((!message && !submission.attachments.length) || message.length > 32000) {
      setError(new ApiError(400, 400, '请输入消息，正文最多 32000 字符。'));
      return false;
    }
    if (options.specSession && (nextMode !== 'plan' || startsGoal)) {
      setError(new ApiError(409, 'SPEC_SESSION_RESTRICTED', '规格会话使用 Plan 讨论；请从任务卡片发起 Build 执行。'));
      return false;
    }
    if (startsSpec && !projectId) {
      setError(new ApiError(400, 'SPEC_PROJECT_REQUIRED', '请选择本次 Spec 所属的项目。'));
      return false;
    }
    if (startsSpec && (submission.attachments.length || submission.files.length)) {
      setError(new ApiError(400, 'SPEC_TEXT_REQUIRED', '请先使用文字需求启动 Spec；附件可在专用会话中继续补充。'));
      return false;
    }
    if (mode === 'project' && !binding && !options.specSession && !startsSpec) {
      setUnboundOpen(true);
      return false;
    }
    if (startsGoal && options.goal && options.goal.status !== 'completed') {
      setError(new ApiError(409, 'GOAL_ALREADY_EXISTS', '请先完成或移除当前目标，再设置新目标。'));
      return false;
    }
    if (blocked) return false;
    if (submission.files.length) {
      if (usesRemoteFiles) {
        setError(new ApiError(400, 400, '请从远程工作目录选择附件。'));
        return false;
      }
      if (!config.data?.capabilities.uploads) {
        setError(new ApiError(503, 503, '附件上传服务尚未就绪。'));
        return false;
      }
      uploads.add(submission.files);
      return false;
    }
    try {
      const profileId = submission.model ?? modelProfileId;
      const profile = modelSettings.profiles.find((entry) => entry.id === profileId);
      const requestedEffort = submission.reasoningEffort ?? reasoningEffort;
      const runConfig: Configuration = {
        backendId: runtime?.backendId ?? 'nova',
        modelId: await modelSettings.resolveModelId(profileId),
        reasoningEffort: profile?.thinkingLevels.includes(requestedEffort as ModelThinkingLevel)
          ? (requestedEffort as ModelThinkingLevel)
          : undefined,
        mode: startsSpec ? 'plan' : nextMode,
        remoteConnectionId: remoteConnectionId || undefined,
      };
      if (config.data?.capabilities.execution && !runConfig.modelId)
        throw new ApiError(400, 'MODEL_REQUIRED', '请先选择或配置一个模型。');
      const payload = submission.attachments.map((item) => item.metadata);
      const blocks: InputBlock[] = [
        ...(message ? [{ id: 'text', type: 'text' as const, text: message }] : []),
        ...payload.map((attachment, index) => ({
          id: 'attachment:' + index,
          type: attachment.mimeType.startsWith('image/') ? ('image' as const) : ('file' as const),
          attachment,
        })),
      ];
      const goal = startsGoal
        ? { objective: message, maxIterations, acceptanceCriteria }
        : undefined;
      if (startsSpec) {
        if (!options.onStartSpec) throw new ApiError(400, 'SPEC_UNAVAILABLE', '当前页面无法启动 Spec。');
        await options.onStartSpec({ message, configuration: runConfig });
        saveDraft(accountId, draftId, '');
        setText('');
        setSpecArmed(false);
        optionStore.set(null);
      } else if (conversationId) {
        await append.mutateAsync({
          blocks,
          mode: 'next_run',
          configuration: runConfig,
          ...(goal ? { goal } : {}),
        });
      } else {
        const conversation = await create.mutateAsync({
          mode,
          ...(mode === 'project' && projectId ? { projectId } : {}),
          configuration: runConfig,
          ...(goal ? { goal } : {}),
          initialInput: { blocks },
        });
        saveDraft(accountId, draftId, '');
        setText('');
        optionStore.set(null);
        onCreated?.(conversation.id);
      }
      uploads.clear();
      setRemote([]);
      setGoalArmed(false);
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    }
  }

  function invokeSkill(skill: ComposerSkill) {
    if (skill.id === 'goal') {
      setSpecArmed(false);
      if (options.goal && options.goal.status !== 'completed') setGoalDialogOpen(true);
      else setGoalArmed(true);
    } else if (skill.id === 'spec') { setSpecArmed(true); setGoalArmed(false); }
    else if (skill.id === 'plan') { setSpecArmed(false); setExecutionMode('plan'); }
    else if (skill.id === 'build') { setSpecArmed(false); setExecutionMode('build'); }
    else if (skill.id === 'clear') onClearContext?.();
  }
  const canSteer = isRunning && options.steeringEnabled === true;
  const queuedMessages = useMemo<ChatQueuedMessage[]>(
    () =>
      pendingInputs.map((input) => ({
        id: input.id,
        text: input.input.blocks
          .map((block) => (block.type === 'text' ? block.text : block.attachment.name))
          .join(' '),
        isSteering: input.input.mode === 'steer' || steeringId === input.id,
        canSteer:
          canSteer &&
          input.state === 'queued' &&
          !input.runId &&
          input.input.mode === 'next_run' &&
          input.input.blocks.every((block) => block.type === 'text'),
      })),
    [pendingInputs, steeringId, canSteer],
  );
  function removeQueued(inputId: string) {
    remove.mutate(inputId);
  }
  async function steerQueued(inputId: string) {
    if (!queuedMessages.some((item) => item.id === inputId && item.canSteer) || steeringId) return;
    setSteeringId(inputId);
    setError(null);
    try {
      await steer.mutateAsync(inputId);
    } catch (cause) {
      setError(cause);
    } finally {
      setSteeringId(null);
    }
  }
  function addAttachment() {
    setError(null);
    if (remoteConnectionId) {
      if (!selectedRemote) {
        setError(new ApiError(409, 'REMOTE_UNAVAILABLE', '请先配置并验证 SSH 连接。'));
        return;
      }
      setExplorerOpen(true);
    } else if (mode === 'project') {
      if (!binding?.runnerId) {
        setUnboundOpen(true);
        return;
      }
      if (!config.data?.capabilities.remoteFiles) {
        setError(new ApiError(503, 503, 'Runner 文件服务尚未就绪。'));
        return;
      }
      setExplorerOpen(true);
    } else if (config.data?.capabilities.uploads) fileInputRef.current?.click();
    else setError(new ApiError(503, 503, '附件上传服务尚未就绪。'));
  }
  const sshRoot = selectedRemote?.rootPath ?? '';
  const runnerId = binding?.runnerId;
  const appendRemoteFiles = (files: ComposerAttachment<Attachment>[]) =>
    setRemote((current) =>
      [
        ...current,
        ...files.filter((file) => !current.some((existing) => existing.name === file.name)),
      ].slice(0, 32),
    );
  const explorerState = {
    open: explorerOpen,
    close: () => setExplorerOpen(false),
    append: appendRemoteFiles,
    fail: (cause: unknown) => setError(cause),
  };
  const explorerProps: RemoteExplorerProps | undefined =
    remoteConnectionId && selectedRemote
      ? buildAttachmentsExplorer(
          {
            title: '从 SSH 远程添加附件',
            initialPath: '/',
            selectedPaths: remote.flatMap((item) =>
              item.metadata.ref.kind === 'ssh'
                ? [resolveRemotePath(sshRoot, item.metadata.ref.path)]
                : [],
            ),
            loadDirectory: (path, signal) => loadRemoteDirectory(remoteConnectionId, path, signal),
            summarise: (paths) => summariseRemoteFiles(remoteConnectionId, { paths }),
            displayName: (item) => relativeRemotePath(sshRoot, item.path),
            describe: (name) => 'SSH · ' + name,
            makeRef: (item) => ({ kind: 'ssh', remoteConnectionId, path: item.path }),
            failureMessage: '无法读取远程文件摘要，请重试。',
          },
          explorerState,
        )
      : mode === 'project' && binding && runnerId
        ? buildAttachmentsExplorer(
            {
              title: '从项目 Runner 添加附件',
              initialPath: binding.canonicalCwd,
              selectedPaths: remote.flatMap((item) =>
                item.metadata.ref.kind === 'runner' ? [item.metadata.ref.path] : [],
              ),
              loadDirectory: (path, signal) => loadRunnerDirectory(runnerId, path, signal),
              summarise: (paths) => summariseRunnerFiles(runnerId, { paths }),
              displayName: (item) => item.path,
              makeRef: (item) => ({
                kind: 'runner',
                runnerId,
                workspaceId: binding.workspaceId,
                path: item.path,
              }),
              failureMessage: '无法获取文件摘要，请重试。',
            },
            explorerState,
          )
        : undefined;

  let placeholder = '想规划、实现或讨论什么？/ 使用命令…';
  if (isRunning) {
    placeholder = '继续补充任务，发送后进入队列…';
  } else if (executionMode === 'plan') {
    placeholder = '先分析和制定计划，/ 使用命令…';
  } else if (goalArmed) {
    placeholder = '描述一个明确、可验证的目标…';
  }

  const composer: ChatComposerConfig<Attachment> = {
    value: text,
    onTextChange: changeText,
    ...(!usesRemoteFiles ? { onFilesSelected: (files: File[]) => uploads.add(files) } : {}),
    disabled: sending,
    submitDisabled: blocked,
    allowFiles: !usesRemoteFiles && Boolean(config.data?.capabilities.uploads),
    accept: IMAGE_ACCEPT,
    attachments,
    onAttachmentsChange: (next) => {
      if (usesRemoteFiles) setRemote(next);
      else {
        const ids = new Set(next.map((item) => item.id));
        for (const entry of uploads.entries)
          if (entry.status === 'ready' && !ids.has(entry.id)) uploads.remove(entry.id);
      }
    },
    onAttachmentButtonClick: addAttachment,
    models: modelOptions,
    model: modelProfileId,
    onModelChange: changeModel,
    reasoningEfforts,
    reasoningEffort,
    onReasoningEffortChange: changeReasoning,
    skills,
    onSkillInvoke: invokeSkill,
    contextUsage,
    placeholder,
  };
  return {
    specSession: Boolean(options.specSession),
    canStartSpec: !conversationId,
    specArmed,
    setSpecArmed,
    composer,
    submit,
    uploads,
    fileInputRef,
    blocked,
    sending,
    error,
    queuedMessages,
    removeQueued,
    steerQueued,
    isSteering: steeringId !== null,
    removeError: remove.error,
    explorerProps,
    unboundOpen,
    closeUnbound: () => setUnboundOpen(false),
    mode,
    binding,
    projectId,
    executionMode,
    setExecutionMode,
    modelProfileId,
    modelProfiles: modelSettings.profiles,
    modelLoading: modelSettings.catalogLoading,
    changeModel,
    reasoningEfforts,
    reasoningEffort,
    changeReasoning,
    remoteConnectionId,
    selectedRemote,
    goal: options.goal,
    goalArmed,
    setGoalArmed,
    maxIterations,
    setMaxIterations,
    acceptanceCriteria,
    setAcceptanceCriteria,
    goalDialogOpen,
    setGoalDialogOpen,
  };
}
export type ConversationComposerController = ReturnType<typeof useConversationComposer>;
