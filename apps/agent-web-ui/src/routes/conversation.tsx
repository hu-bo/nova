import { Composer, DecisionPrompt, MessageList, TodoPanel, type ComposerSubmission } from "@nova/chat-ui";
import { AlertTriangle, ArrowLeft, CircleStop, FolderKanban, MessageCircle, Server, Wifi, WifiOff } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Dialog } from "../components/ui/dialog.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { useConversationMutations } from "../conversation/mutations.js";
import { ConversationProvider, useConversationStore } from "../conversation/store.js";
import { useModelSettings } from "../model/provider.js";
import { useConversations, useProject } from "../project/use-projects.js";
import { RunnerBadge } from "./home.js";
import { RunnerManagerDialog } from "../runner/runner-manager-dialog.js";

export function ConversationRoute() {
  const { projectId, conversationId } = useParams();
  const conversations = useConversations(projectId);
  const projectQuery = useProject(projectId);

  if (!conversationId) return <div className="p-8"><ErrorState message="会话路径无效" /></div>;
  if (conversations.isLoading || (projectId && projectQuery.isLoading)) return <div className="p-6 lg:p-8"><LoadingState label="正在打开会话" /></div>;
  if (conversations.error) return <div className="p-6 lg:p-8"><ErrorState message={errorMessage(conversations.error)} onRetry={() => void conversations.refetch()} /></div>;
  const conversation = conversations.data?.items.find(item => item.id === conversationId);
  if (!conversation) return <div className="p-6 lg:p-8"><ErrorState title="会话不存在" message="它可能已被删除、超出当前列表范围，或你没有访问权限。" /></div>;

  return (
    <ConversationProvider key={conversationId} conversationId={conversationId}>
      <ConversationView
        conversation={conversation}
        project={projectQuery.project}
      />
    </ConversationProvider>
  );
}

function ConversationView({
  conversation,
  project,
}: {
  conversation: { id: string; title: string; runnerId: string; projectId: string | null };
  project?: { id: string; name: string; workspace: string | null; runnerState: string } | undefined;
}) {
  const models = useModelSettings();
  const [modelProfileId, setModelProfileId] = useState(models.defaultProfileId || models.profiles[0]?.id || "");
  const [queue, setQueue] = useState<"steering" | "nextRun">("steering");
  const [runnerOpen, setRunnerOpen] = useState(false);
  const [runnerWarning, setRunnerWarning] = useState<ComposerSubmission | null>(null);
  const store = useConversationStore();
  const mutations = useConversationMutations(conversation.id, modelProfileId);
  const incompleteTodos = store.state.todos.filter(todo => todo.status !== "completed").length;
  const selectedProfile = models.profiles.find(profile => profile.id === modelProfileId);

  const modelOptions = useMemo(() => models.profiles.map(profile => ({
    value: profile.id,
    label: `${profile.model} (${profile.providerName})`,
  })), [models.profiles]);

  if (store.isLoading) return <div className="p-6"><LoadingState label="正在同步历史消息" /></div>;
  if (store.historyError) return <div className="p-6"><ErrorState message={errorMessage(store.historyError)} onRetry={store.retryHistory} /></div>;

  function submit(submission: ComposerSubmission) {
    if (project?.runnerState === "disconnected") {
      setRunnerWarning(submission);
      return false;
    }
    const selectedQueue = store.state.isRunning ? queue : undefined;
    return mutations.send(submission, selectedQueue);
  }

  async function confirmDisconnectedSend() {
    if (!runnerWarning) return;
    await mutations.send(runnerWarning, store.state.isRunning ? queue : undefined);
    setRunnerWarning(null);
  }

  return (
    <div className="nova-conversation-viewport flex min-h-0 overflow-hidden bg-slate-50">
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-14 items-center gap-3 border-b border-slate-200 bg-white px-4 sm:px-5">
          <Link to={project ? `/p/${project.id}` : "/app"} className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-900 sm:size-9" aria-label="返回会话列表"><ArrowLeft className="size-4" aria-hidden="true" /></Link>
          <div className="min-w-0 flex-1"><h1 className="truncate text-sm font-semibold text-slate-900">{conversation.title || "未命名会话"}</h1><div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500"><ConnectionBadge connection={store.state.connection} /><span aria-hidden="true">·</span><span className="truncate">{project?.workspace ?? "独立 Chat"}</span></div></div>
          {project && <span className="hidden md:block"><RunnerBadge state={project.runnerState} /></span>}
          <span className="hidden sm:block"><Button variant="ghost" icon={<Server className="size-4" aria-hidden="true" />} onClick={() => setRunnerOpen(true)}>切换 Runner</Button></span>
          <Button aria-label={mutations.abortMutation.isPending ? "正在中断" : "中断当前运行"} className="px-3 sm:px-4" variant="danger" disabled={!store.state.isRunning || mutations.abortMutation.isPending} icon={<CircleStop className="size-4" aria-hidden="true" />} onClick={() => void mutations.abort()}><span className="hidden sm:inline">{mutations.abortMutation.isPending ? "中断中…" : "中断"}</span></Button>
        </header>

        {project?.runnerState === "disconnected" && (
          <div className="flex items-start gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" /><p className="min-w-0 flex-1 leading-5">Runner 未连接。发送前会再次确认，且服务端会明确拒绝无法执行的 coding 请求；不会降级成普通 Chat。</p><Button size="sm" variant="outline" onClick={() => setRunnerOpen(true)}>查看启动命令</Button></div>
        )}

        <div className={`grid min-h-0 flex-1 ${incompleteTodos ? "xl:grid-cols-[minmax(0,1fr)_280px]" : ""}`}>
          <div className="flex min-h-0 min-w-0 flex-col">
            <div className="relative min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-5">
              {store.state.messages.length ? (
                <MessageList messages={store.state.messages} onRetry={messageId => void mutations.retry(messageId)} />
              ) : (
                <div className="grid h-full place-items-center"><EmptyState icon={project ? <FolderKanban className="size-5" /> : <MessageCircle className="size-5" />} title={project ? "告诉 Agent 想完成的目标" : "从一个问题开始"} description={project ? `Agent 将在 ${project.workspace ?? "当前 workspace"} 中工作，过程会实时显示在这里。` : "可以讨论方案、分析代码或制定多步计划。"} /></div>
              )}
            </div>

            <div className="shrink-0 border-t border-slate-200 bg-white px-3 pb-2 pt-2 sm:px-4">
              {incompleteTodos > 0 && <div className="mb-2 xl:hidden"><TodoPanel items={store.state.todos} collapsed /></div>}
              {store.state.error && <div className="mb-2 flex items-start justify-between gap-3 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200" role="alert"><span>{store.state.error}</span><button type="button" className="font-semibold" onClick={() => store.dispatch({ type: "clear-error" })}>关闭</button></div>}
              {mutations.sendMutation.error && <div className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">{errorMessage(mutations.sendMutation.error)}</div>}
              {mutations.abortMutation.error && <div className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">中断失败：{errorMessage(mutations.abortMutation.error)}</div>}
              {mutations.decisionMutation.error && <div className="mb-2 rounded-xl bg-rose-50 px-3 py-2.5 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">{errorMessage(mutations.decisionMutation.error)}</div>}
              {store.state.pendingDecision && <div className="mb-2"><DecisionPrompt request={store.state.pendingDecision} disabled={mutations.decisionMutation.isPending} onResolve={mutations.resolveDecision} /></div>}
              {store.state.isRunning && (
                <div className="mb-2 flex flex-wrap items-center gap-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600 ring-1 ring-slate-200"><span className="font-semibold text-slate-700">正在运行，新消息：</span><label className="flex items-center gap-1.5"><input type="radio" name="queue" checked={queue === "steering"} onChange={() => setQueue("steering")} className="accent-indigo-600" />立即调整</label><label className="flex items-center gap-1.5"><input type="radio" name="queue" checked={queue === "nextRun"} onChange={() => setQueue("nextRun")} className="accent-indigo-600" />下一轮再说</label></div>
              )}
              <Composer
                disabled={mutations.sendMutation.isPending}
                allowFiles
                placeholder={project ? "让 Agent 做点什么，Shift+Enter 换行" : "问点什么，Shift+Enter 换行"}
                models={modelOptions}
                model={modelProfileId}
                onModelChange={setModelProfileId}
                onSubmit={submit}
              />
              <div className="mt-1.5 flex items-center justify-between gap-3 px-1 text-[11px] text-slate-400"><span>{selectedProfile ? `${selectedProfile.source === "server" ? "服务端" : selectedProfile.provider} · ${selectedProfile.model}` : "请先配置模型"}</span><span>模型变更会与下一次发送串行下发</span></div>
            </div>
          </div>

          {incompleteTodos > 0 && <aside className="hidden min-h-0 border-l border-slate-200 bg-white p-3 xl:block"><div className="sticky top-3"><p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">当前计划</p><TodoPanel items={store.state.todos} /></div></aside>}
        </div>
      </section>

      <RunnerManagerDialog open={runnerOpen} onClose={() => setRunnerOpen(false)} selectedRunnerId={conversation.runnerId} onSelect={runnerId => mutations.changeRunner(runnerId)} />

      <Dialog open={Boolean(runnerWarning)} onClose={() => setRunnerWarning(null)} title="Runner 当前未连接" description="继续发送不会切换成 Chat 模式，服务端可能返回明确的 Runner 错误。" size="md">
        <div className="space-y-5"><p className="text-sm leading-6 text-slate-600">建议先打开 Runner 管理器复制启动命令，并等待状态转绿。如果仍要发送，原消息会保留并按 Project 模式提交。</p><div className="flex flex-wrap justify-end gap-3"><Button onClick={() => setRunnerWarning(null)}>先不发送</Button><Button variant="outline" onClick={() => setRunnerOpen(true)}>管理 Runner</Button><Button variant="primary" disabled={mutations.sendMutation.isPending} onClick={() => void confirmDisconnectedSend()}>{mutations.sendMutation.isPending ? "发送中…" : "仍然发送"}</Button></div></div>
      </Dialog>
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: "connecting" | "open" | "reconnecting" | "closed" }) {
  const open = connection === "open";
  return <span className={`inline-flex items-center gap-1 ${open ? "text-emerald-600" : connection === "closed" ? "text-rose-600" : "text-amber-600"}`}>{open ? <Wifi className="size-3" aria-hidden="true" /> : <WifiOff className="size-3" aria-hidden="true" />}{connection === "open" ? "实时连接" : connection === "connecting" ? "正在连接" : connection === "reconnecting" ? "正在重连" : "连接关闭"}</span>;
}
