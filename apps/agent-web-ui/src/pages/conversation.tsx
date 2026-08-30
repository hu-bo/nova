import {
  Composer,
  DecisionPrompt,
  MessageList,
  RemoteExplorer,
  TodoPanel,
  type ComposerAttachment,
  type ComposerSubmission,
} from "@nova/chat-ui";
import {
  AlertTriangle,
  ArrowLeft,
  CornerDownLeft,
  CornerDownRight,
  FolderKanban,
  MessageCircle,
  Server,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { useConversationMutations, type RunnerAttachmentMetadata } from "../conversation/mutations.js";
import { ConversationProvider, useConversationStore } from "../conversation/store.js";
import { LocalStore } from "../lib/storage.js";
import { useModelSettings } from "./settings/model/provider.js";
import { useConversations, useProject } from "./project/use-projects.js";
import { RunnerBadge } from "./home.js";
import { RunnerManagerDialog } from "./settings/runner/runner-manager-dialog.js";
import { useRunnerDirectoryLoader } from "./settings/runner/use-runners.js";

const SELECTED_MODEL_STORE = new LocalStore("nova_selected_model_profile", "");

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

  return (
    <ConversationProvider key={conversationId} conversationId={conversationId}>
      <ConversationView conversation={conversation} project={projectQuery.project} />
    </ConversationProvider>
  );
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
  // 存储的模型可能已被删除或不在当前用户的服务端目录里，此时回落到默认值
  const modelProfileId = models.profiles.some((profile) => profile.id === storedProfileId)
    ? storedProfileId
    : models.defaultProfileId || models.profiles[0]?.id || "";
  const [runnerOpen, setRunnerOpen] = useState(false);
  const [runnerWarning, setRunnerWarning] = useState<ComposerSubmission<RunnerAttachmentMetadata> | null>(null);
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [compactNotice, setCompactNotice] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment<RunnerAttachmentMetadata>[]>([]);
  const store = useConversationStore();
  const mutations = useConversationMutations(conversation.id, modelProfileId);
  const runnerId = conversation.runnerId ?? project?.runnerId ?? "";
  const loadDirectory = useRunnerDirectoryLoader(runnerId);
  const selectedRunnerAttachmentPaths = useMemo(
    () =>
      attachments
        .filter((attachment) => attachment.metadata.runnerId === runnerId)
        .map((attachment) => attachment.metadata.path),
    [attachments, runnerId],
  );
  useEffect(() => setAttachmentOpen(false), [runnerId]);
  const incompleteTodos = store.state.todos.filter((todo) => todo.status !== "completed").length;
  const selectedProfile = models.profiles.find((profile) => profile.id === modelProfileId);
  const contextUsage =
    store.state.contextUsage ??
    (selectedProfile ? { inputTokens: null, contextWindow: selectedProfile.contextWindow } : undefined);
  const composerSkills = useMemo(
    () => [
      {
        id: "compact",
        command: "compact",
        label: "压缩上下文",
        disabled: store.state.isRunning || mutations.compactMutation.isPending,
      },
    ],
    [mutations.compactMutation.isPending, store.state.isRunning],
  );

  const modelOptions = useMemo(
    () =>
      models.profiles.map((profile) => ({
        value: profile.id,
        label: `${profile.model} (${profile.providerName})`,
      })),
    [models.profiles],
  );

  if (store.isLoading)
    return (
      <div className="p-6">
        <LoadingState label="正在同步历史消息" />
      </div>
    );
  if (store.historyError)
    return (
      <div className="p-6">
        <ErrorState message={errorMessage(store.historyError)} onRetry={store.retryHistory} />
      </div>
    );

  function submit(submission: ComposerSubmission<RunnerAttachmentMetadata>) {
    if (project && (!project.workspace || !project.runnerId)) {
      setRunnerWarning(submission);
      return false;
    }
    return mutations.send(submission);
  }

  return (
    <div className="nova-conversation-viewport flex min-h-0 overflow-hidden bg-slate-50">
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex min-h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-5">
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
          <span className="hidden sm:block">
            <Button
              variant="ghost"
              icon={<Server className="size-4" aria-hidden="true" />}
              onClick={() => setRunnerOpen(true)}
            >
              切换 Runner
            </Button>
          </span>
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

        <div
          className={`grid min-h-0 flex-1 overflow-hidden ${incompleteTodos ? "xl:grid-cols-[minmax(0,1fr)_280px]" : ""}`}
        >
          <div className="flex min-h-0 min-w-0 flex-col overflow-hidden">
            <div className="relative min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-5">
              {store.state.messages.length ? (
                <MessageList messages={store.state.messages} onRetry={(messageId) => void mutations.retry(messageId)} />
              ) : (
                <div className="grid h-full place-items-center">
                  <EmptyState
                    icon={project ? <FolderKanban className="size-5" /> : <MessageCircle className="size-5" />}
                    title={project ? "告诉 Agent 想完成的目标" : "从一个问题开始"}
                    description={
                      project
                        ? `Agent 将在 ${project.workspace ?? "当前 workspace"} 中工作，过程会实时显示在这里。`
                        : "可以讨论方案、分析代码或制定多步计划。"
                    }
                  />
                </div>
              )}
            </div>

            <div className="min-w-0 shrink-0 overflow-visible border-t border-slate-200 bg-white px-3 pb-2 pt-2 sm:px-4">
              {incompleteTodos > 0 && (
                <div className="mb-2 xl:hidden">
                  <TodoPanel items={store.state.todos} collapsed />
                </div>
              )}
              {store.state.error && (
                <div
                  className="mb-2 flex items-start justify-between gap-3 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  <span>{store.state.error}</span>
                  <button
                    type="button"
                    className="font-semibold"
                    onClick={() => store.dispatch({ type: "clear-error" })}
                  >
                    关闭
                  </button>
                </div>
              )}
              {mutations.sendMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  {errorMessage(mutations.sendMutation.error)}
                </div>
              )}
              {mutations.abortMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  中断失败：{errorMessage(mutations.abortMutation.error)}
                </div>
              )}
              {mutations.compactMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  压缩失败：{errorMessage(mutations.compactMutation.error)}
                </div>
              )}
              {compactNotice && (
                <div
                  className="mb-2 flex items-start justify-between gap-3 rounded-xl bg-indigo-50 px-3 py-2.5 text-sm text-indigo-800 ring-1 ring-indigo-200"
                  role="status"
                >
                  <span>{compactNotice}</span>
                  <button type="button" className="font-semibold" onClick={() => setCompactNotice(null)}>
                    关闭
                  </button>
                </div>
              )}
              {attachmentError && (
                <div
                  className="mb-2 flex items-start justify-between gap-3 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200"
                  role="alert"
                >
                  <span>{attachmentError}</span>
                  <button type="button" className="font-semibold" onClick={() => setAttachmentError(null)}>
                    关闭
                  </button>
                </div>
              )}
              {mutations.decisionMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  {errorMessage(mutations.decisionMutation.error)}
                </div>
              )}
              {mutations.steerMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  调整方向失败：{errorMessage(mutations.steerMutation.error)}
                </div>
              )}
              {mutations.queuedRunMutation.error && (
                <div
                  className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200"
                  role="alert"
                >
                  待处理消息发送失败：{errorMessage(mutations.queuedRunMutation.error)}
                </div>
              )}
              {(store.state.connection === "connecting" || store.state.connection === "reconnecting") && (
                <div
                  className="mb-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200"
                  role="status"
                >
                  {store.state.connection === "connecting" ? "正在连接实时消息流" : "实时消息流已断开，正在重连"}
                </div>
              )}
              {store.state.pendingDecision && (
                <div className="mb-2">
                  <DecisionPrompt
                    request={store.state.pendingDecision}
                    disabled={mutations.decisionMutation.isPending}
                    onResolve={mutations.resolveDecision}
                  />
                </div>
              )}
              {store.state.queuedMessages.length > 0 && (
                <div className="relative z-0 mx-4 -mb-3 overflow-hidden rounded-t-2xl border border-b-0 border-slate-200 bg-white pb-3 shadow-sm sm:mx-5">
                  <div className="max-h-44 overflow-x-hidden overflow-y-auto overscroll-contain">
                    {store.state.queuedMessages.map((queued) => {
                      const { message } = queued;
                      const text = message.blocks.find((block) => block.type === "text")?.text ?? "待处理消息";
                      const steering =
                        mutations.steerMutation.isPending &&
                        mutations.steerMutation.variables?.message.id === message.id;
                      return (
                        <div
                          key={message.id}
                          className="flex min-h-11 min-w-0 items-center gap-2 overflow-hidden border-b border-slate-100 px-3.5 text-sm last:border-b-0"
                        >
                          <CornerDownRight className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-slate-800">{text}</span>
                          <button
                            type="button"
                            disabled={mutations.steerMutation.isPending}
                            onClick={() => void mutations.steerQueued(message.id)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-45"
                          >
                            <CornerDownLeft className="size-3" aria-hidden="true" />
                            {steering ? "正在调整" : "调整方向"}
                          </button>
                          <button
                            type="button"
                            aria-label="删除待处理消息"
                            disabled={mutations.steerMutation.isPending}
                            onClick={() => mutations.removeQueued(message.id)}
                            className="grid size-7 shrink-0 place-items-center rounded-md text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 disabled:opacity-45"
                          >
                            <Trash2 className="size-3.5" aria-hidden="true" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <div className="relative z-10">
                <Composer
                  disabled={mutations.sendMutation.isPending || mutations.compactMutation.isPending}
                  isRunning={store.state.isRunning}
                  isAborting={mutations.abortMutation.isPending}
                  onAbort={() => mutations.abort()}
                  allowFiles
                  attachments={attachments}
                  onAttachmentsChange={setAttachments}
                  onAttachmentButtonClick={() => {
                    if (!runnerId) {
                      setAttachmentError(
                        "请先为当前会话选择 Runner，再从 Runner 中添加附件。你仍可将本地文件拖到输入框中。",
                      );
                      return;
                    }
                    setAttachmentError(null);
                    setAttachmentOpen(true);
                  }}
                  placeholder={project ? "让 Agent 做点什么，Shift+Enter 换行" : "问点什么，Shift+Enter 换行"}
                  models={modelOptions}
                  model={modelProfileId}
                  skills={composerSkills}
                  contextUsage={contextUsage}
                  onSkillInvoke={async (skill) => {
                    if (skill.id !== "compact") return;
                    setCompactNotice(null);
                    const result = await mutations.compact();
                    setCompactNotice(
                      result.compacted ? "上下文已压缩，占用将在下一次模型请求后更新。" : "当前没有可压缩的上下文。",
                    );
                  }}
                  onModelChange={(id) => {
                    SELECTED_MODEL_STORE.set(id);
                    setStoredProfileId(id);
                  }}
                  onSubmit={submit}
                />
              </div>
            </div>
          </div>

          {incompleteTodos > 0 && (
            <aside className="hidden min-h-0 overflow-x-hidden overflow-y-auto border-l border-slate-200 bg-white p-3 xl:block">
              <div className="sticky top-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">当前计划</p>
                <TodoPanel items={store.state.todos} />
              </div>
            </aside>
          )}
        </div>
      </section>

      <RunnerManagerDialog
        open={runnerOpen}
        onClose={() => setRunnerOpen(false)}
        selectedRunnerId={conversation.runnerId ?? undefined}
        onSelect={(runnerId) => mutations.changeRunner(runnerId)}
      />

      <RemoteExplorer
        open={attachmentOpen}
        onClose={() => setAttachmentOpen(false)}
        loadDirectory={loadDirectory}
        mode="file"
        multiple
        initialPath={project?.workspace ?? undefined}
        selectedPaths={selectedRunnerAttachmentPaths}
        onConfirm={(entries) => {
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
        }}
        title="从 Runner 添加附件"
      />

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
