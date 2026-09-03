import { Chat, type ComposerAttachment, type ComposerSubmission, type ChatFeedback } from "@nova/chat-ui";
import { AlertTriangle, ArrowLeft, FolderKanban, MessageCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { useConversationMutations, type RunnerAttachmentMetadata } from "../conversation/mutations.js";
import { useConversationSession, useConversationStore } from "../conversation/store.js";
import { LocalStore } from "../lib/storage.js";
import { displayWorkspacePath } from "../lib/workspace-path.js";
import { useModelSettings } from "./settings/model/provider.js";
import { useConversations, useProject } from "./project/use-projects.js";
import { RunnerBadge } from "./home.js";
import { useRunnerDirectoryLoader } from "./settings/runner/use-runners.js";

const SELECTED_MODEL_STORE = new LocalStore("nova_selected_model_profile", "");
const SELECTED_REASONING_STORE = new LocalStore("nova_selected_reasoning_effort", "");

export function ConversationRoute() {
  const { projectId, conversationId } = useParams();
  const conversations = useConversations(projectId);
  const projectQuery = useProject(projectId);

  if (!conversationId)
    return (
      <div className="p-8">
        <ErrorState message="会话路径无效" />
      </div>
    );
  if (conversations.isLoading || (projectId && projectQuery.isLoading))
    return (
      <div className="p-6 lg:p-8">
        <LoadingState label="正在打开会话" />
      </div>
    );
  if (conversations.error)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState message={errorMessage(conversations.error)} onRetry={() => void conversations.refetch()} />
      </div>
    );
  const conversation = conversations.data?.items.find((item) => item.id === conversationId);
  if (!conversation)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState title="会话不存在" message="它可能已被删除、超出当前列表范围，或你没有访问权限。" />
      </div>
    );

  return <ConversationView key={conversationId} conversation={conversation} project={projectQuery.project} />;
}

function ConversationView({
  conversation,
  project,
}: {
  conversation: { id: string; title: string; runnerId: string | null; projectId: string | null };
  project?:
    { id: string; name: string; workspace: string | null; runnerId: string | null; runnerState: string } | undefined;
}) {
  const models = useModelSettings();
  const [storedProfileId, setStoredProfileId] = useState(() => SELECTED_MODEL_STORE.get());
  const [storedReasoning, setStoredReasoning] = useState(() => SELECTED_REASONING_STORE.get());
  // 存储的模型可能已被删除或不在当前用户的服务端目录里，此时回落到默认值
  const modelProfileId = models.profiles.some((profile) => profile.id === storedProfileId)
    ? storedProfileId
    : models.defaultProfileId || models.profiles[0]?.id || "";
  const [runnerWarning, setRunnerWarning] = useState<ComposerSubmission<RunnerAttachmentMetadata> | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const [clearNotice, setClearNotice] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment<RunnerAttachmentMetadata>[]>([]);
  const session = useConversationSession(conversation.id);
  const store = useConversationStore(conversation.id);
  const runnerId = conversation.runnerId ?? project?.runnerId ?? "";
  const selectedProfile = models.profiles.find((profile) => profile.id === modelProfileId);
  const reasoningEfforts = useMemo<{ value: string; label: string }[]>(
    () =>
      (selectedProfile?.thinkingLevels ?? []).map((level) => ({
        value: level,
        label: { off: "关闭", low: "低", medium: "中", high: "高", max: "最大" }[level] ?? level,
      })),
    [selectedProfile?.thinkingLevels],
  );
  // 存储的推理强度可能在当前模型中不存在，需要过滤
  const reasoningEffort = reasoningEfforts.some((e) => e.value === storedReasoning)
    ? storedReasoning
    : (reasoningEfforts[0]?.value ?? "");
  const mutations = useConversationMutations(
    conversation.id,
    modelProfileId,
    session.ensureStreamConnected,
    reasoningEffort,
  );
  const loadDirectory = useRunnerDirectoryLoader(runnerId);
  const selectedRunnerAttachmentPaths = useMemo(
    () =>
      attachments
        .filter((attachment) => attachment.metadata.runnerId === runnerId)
        .map((attachment) => attachment.metadata.path),
    [attachments, runnerId],
  );
  useEffect(() => setAttachmentOpen(false), [runnerId]);
  const contextUsage =
    store.state.contextUsage ??
    (selectedProfile
      ? {
          estimatedInputTokens: 0,
          lastMeasuredInputTokens: null,
          contextWindow: selectedProfile.contextWindow,
          maxInputTokens: Math.max(
            1,
            selectedProfile.contextWindow -
              selectedProfile.maxOutput -
              Math.max(1_024, Math.ceil(selectedProfile.contextWindow * 0.02)),
          ),
          confidence: "low" as const,
        }
      : undefined);
  const composerSkills = useMemo(
    () => [
      {
        id: "compact",
        command: "compact",
        label: "压缩上下文",
        disabled: store.state.isRunning || mutations.compactMutation.isPending,
      },
      {
        id: "clear",
        command: "clear",
        label: "清除上下文",
        disabled: store.state.isRunning || mutations.clearMutation.isPending,
      },
    ],
    [mutations.clearMutation.isPending, mutations.compactMutation.isPending, store.state.isRunning],
  );

  const modelOptions = useMemo(
    () =>
      models.profiles.map((profile) => ({
        value: profile.id,
        label: `${profile.model} (${profile.providerName})`,
      })),
    [models.profiles],
  );

  if (session.isLoading)
    return (
      <div className="p-6">
        <LoadingState label="正在同步历史消息" />
      </div>
    );
  if (session.historyError)
    return (
      <div className="p-6">
        <ErrorState message={errorMessage(session.historyError)} onRetry={session.retryHistory} />
      </div>
    );

  function submit(submission: ComposerSubmission<RunnerAttachmentMetadata>) {
    if (project && (!project.workspace || !project.runnerId)) {
      setRunnerWarning(submission);
      return false;
    }
    return mutations.send(submission);
  }

  const feedback: ChatFeedback[] = [];
  if (store.state.error)
    feedback.push({ id: "conversation", message: store.state.error, tone: "error", dismissible: true });
  if (mutations.sendMutation.error)
    feedback.push({ id: "send", message: errorMessage(mutations.sendMutation.error), tone: "error" });
  if (mutations.abortMutation.error)
    feedback.push({ id: "abort", message: `中断失败：${errorMessage(mutations.abortMutation.error)}`, tone: "error" });
  if (mutations.compactMutation.error)
    feedback.push({
      id: "compact-error",
      message: `压缩失败：${errorMessage(mutations.compactMutation.error)}`,
      tone: "error",
    });
  if (mutations.clearMutation.error)
    feedback.push({
      id: "clear-error",
      message: `清除上下文失败：${errorMessage(mutations.clearMutation.error)}`,
      tone: "error",
    });
  if (compactNotice) feedback.push({ id: "compact-notice", message: compactNotice, tone: "info", dismissible: true });
  if (clearNotice) feedback.push({ id: "clear-notice", message: clearNotice, tone: "info", dismissible: true });
  if (attachmentError)
    feedback.push({ id: "attachment", message: attachmentError, tone: "warning", dismissible: true });
  if (mutations.decisionMutation.error)
    feedback.push({ id: "decision", message: errorMessage(mutations.decisionMutation.error), tone: "error" });
  if (mutations.steerMutation.error)
    feedback.push({
      id: "steer",
      message: `调整方向失败：${errorMessage(mutations.steerMutation.error)}`,
      tone: "error",
    });
  if (mutations.queuedRunMutation.error)
    feedback.push({
      id: "queued-run",
      message: `待处理消息发送失败：${errorMessage(mutations.queuedRunMutation.error)}`,
      tone: "error",
    });

  return (
    <div className="nova-conversation-viewport flex min-h-0 overflow-hidden bg-slate-50">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-12 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-5">
          <Link
            to={project ? `/p/${project.id}` : "/app"}
            className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 sm:size-9"
            aria-label="返回会话列表"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold text-slate-900">{conversation.title || "未命名会话"}</h1>
          </div>
          {project && (
            <span className="hidden md:block">
              <RunnerBadge state={project.runnerState} />
            </span>
          )}
        </header>

        {project && (!project.workspace || !project.runnerId) && (
          <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <p className="min-w-0 flex-1 leading-5">
              此 Project 尚未绑定 Runner 或 workspace。可以先开始记录需求，首次发送 coding 任务时再完成绑定。
            </p>
            <Link to={`/p/${project.id}`} className="shrink-0 text-sm font-semibold text-amber-900 underline">
              去绑定
            </Link>
          </div>
        )}

        <Chat
          state={{
            messages: store.state.messages,
            todos: store.state.todos,
            queuedMessages: store.state.queuedMessages.map(({ message }) => ({
              id: message.id,
              text: message.blocks.find((block) => block.type === "text")?.text ?? "待处理消息",
              isSteering:
                mutations.steerMutation.isPending && mutations.steerMutation.variables?.message.id === message.id,
            })),
            pendingDecision: store.state.pendingDecision,
            connection: store.state.connection,
            isRunning: store.state.isRunning,
            isAborting: mutations.abortMutation.isPending,
            isResolvingDecision: mutations.decisionMutation.isPending,
            isSteeringQueuedMessage: mutations.steerMutation.isPending,
            feedback,
          }}
          composer={{
            disabled:
              mutations.sendMutation.isPending ||
              mutations.compactMutation.isPending ||
              mutations.clearMutation.isPending,
            allowFiles: true,
            attachments,
            onAttachmentsChange: setAttachments,
            onAttachmentButtonClick: () => {
              if (!runnerId) {
                setAttachmentError("请先为当前会话选择 Runner，再从 Runner 中添加附件。你仍可将本地文件拖到输入框中。");
                return;
              }
              setAttachmentError(null);
              setAttachmentOpen(true);
            },
            placeholder: project ? "让 Agent 做点什么，Shift+Enter 换行" : "问点什么，Shift+Enter 换行",
            models: modelOptions,
            model: modelProfileId,
            skills: composerSkills,
            contextUsage,
            onSkillInvoke: async (skill) => {
              if (skill.id === "compact") {
                setCompactNotice(null);
                const result = await mutations.compact();
                setCompactNotice(
                  result.compacted ? "上下文已压缩，占用将在下一次模型请求后更新。" : "当前没有可压缩的上下文。",
                );
                return;
              }
              if (skill.id === "clear") {
                setClearNotice(null);
                await mutations.clear();
                setClearNotice("上下文已清除；历史消息仍保留在当前会话中。");
              }
            },
            onModelChange: (id) => {
              SELECTED_MODEL_STORE.set(id);
              setStoredProfileId(id);
            },
            reasoningEfforts,
            reasoningEffort,
            onReasoningEffortChange: (value) => {
              SELECTED_REASONING_STORE.set(value);
              setStoredReasoning(value);
            },
          }}
          actions={{
            onSubmit: submit,
            onAbort: mutations.abort,
            onRetryMessage: (messageId) => void mutations.retry(messageId),
            onResolveDecision: mutations.resolveDecision,
            onRemoveQueuedMessage: mutations.removeQueued,
            onSteerQueuedMessage: mutations.steerQueued,
            onDismissFeedback: (id) => {
              if (id === "conversation") store.dispatch({ type: "clear-error" });
              if (id === "compact-notice") setCompactNotice(null);
              if (id === "clear-notice") setClearNotice(null);
              if (id === "attachment") setAttachmentError(null);
            },
          }}
          emptyState={
            <EmptyState
              icon={project ? <FolderKanban className="size-5" /> : <MessageCircle className="size-5" />}
              title={project ? "告诉 Agent 想完成的目标" : "从一个问题开始"}
              description={
                project
                  ? `Agent 将在 ${project.workspace ? displayWorkspacePath(project.workspace) : "当前 workspace"} 中工作，过程会实时显示在这里。`
                  : "可以讨论方案、分析代码或制定多步计划。"
              }
            />
          }
          explorer={{
            open: attachmentOpen,
            onClose: () => setAttachmentOpen(false),
            loadDirectory,
            mode: "file",
            multiple: true,
            initialPath: project?.workspace ?? undefined,
            selectedPaths: selectedRunnerAttachmentPaths,
            onConfirm: (entries) => {
              setAttachments((current) => {
                const merged = new Map(current.map((attachment) => [attachment.id, attachment]));
                for (const entry of entries) {
                  const id = `${runnerId}:${entry.path}`;
                  merged.set(id, {
                    id,
                    name: entry.name,
                    description: entry.path,
                    metadata: { runnerId, path: entry.path },
                  });
                }
                return [...merged.values()].slice(0, 10);
              });
              setAttachmentOpen(false);
            },
            title: "从 Runner 添加附件",
          }}
        />
      </section>

      <Dialog
        open={Boolean(runnerWarning)}
        onClose={() => setRunnerWarning(null)}
        title="先绑定 Runner 与 workspace"
        description="Project 需要明确的执行环境后才能处理这条消息。"
        size="md"
      >
        <div className="space-y-5">
          <p className="text-sm leading-6 text-slate-600">
            这条消息尚未发送。完成 Project 绑定后，请回到此会话重新发送；不会降级成普通 Chat。
          </p>
          <div className="flex flex-wrap justify-end gap-3">
            <Button onClick={() => setRunnerWarning(null)}>先不发送</Button>
            <Link to={`/p/${project?.id}`}>
              <Button variant="primary">去绑定</Button>
            </Link>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
