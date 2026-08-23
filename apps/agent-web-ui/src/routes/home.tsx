import { Activity, ArrowRight, FolderKanban, MessageCircle, Plus, Server, WifiOff } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { NewConversationDialog } from "../project/new-conversation.js";
import { useConversations, useProjects } from "../project/use-projects.js";

export function HomeRoute() {
  const [newOpen, setNewOpen] = useState(false);
  const projects = useProjects();
  const conversations = useConversations();

  if (projects.isLoading || conversations.isLoading) return <div className="p-6 lg:p-8"><LoadingState label="正在准备工作台" /></div>;
  if (projects.error) return <div className="p-6 lg:p-8"><ErrorState message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} /></div>;
  if (conversations.error) return <div className="p-6 lg:p-8"><ErrorState message={errorMessage(conversations.error)} onRetry={() => void conversations.refetch()} /></div>;

  const projectItems = projects.data ?? [];
  const conversationItems = conversations.data?.items ?? [];
  const online = projectItems.filter(project => project.runnerState === "ready" || project.runnerState === "busy").length;

  return (
    <div className="mx-auto max-w-[1500px] p-5 sm:p-6 lg:p-8">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold text-indigo-600">今天想完成什么？</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">从一个清晰的会话开始</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">直接讨论问题，或进入绑定了 Runner 与 workspace 的 Project 完成真实代码任务。</p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" aria-hidden="true" />} onClick={() => setNewOpen(true)}>新建会话</Button>
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="工作台指标">
        <MetricCard icon={<FolderKanban className="size-5" aria-hidden="true" />} label="Projects" value={projectItems.length} meta="固定 workspace 边界" />
        <MetricCard icon={<MessageCircle className="size-5" aria-hidden="true" />} label="最近会话" value={conversationItems.length} meta="最多显示 100 条" />
        <MetricCard icon={<Server className="size-5" aria-hidden="true" />} label="Runner 就绪" value={`${online}/${projectItems.length}`} meta={online ? "可以开始执行" : "需要连接设备"} />
      </section>

      <div className="mt-8 grid min-w-0 gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <section className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div><h2 className="text-lg font-semibold text-slate-900">Projects</h2><p className="mt-1 text-sm text-slate-500">选择一个 workspace 继续工作</p></div>
          </div>
          {projectItems.length ? (
            <div className="grid gap-4 md:grid-cols-2">
              {projectItems.map(project => (
                <Link key={project.id} to={`/p/${project.id}`} className="group rounded-xl bg-white p-5 ring-1 ring-slate-200 transition duration-200 hover:-translate-y-0.5 hover:ring-indigo-200 hover:shadow-soft">
                  <div className="flex items-start justify-between gap-4">
                    <span className="grid size-10 place-items-center rounded-xl bg-slate-100 text-slate-600 group-hover:bg-indigo-50 group-hover:text-indigo-600"><FolderKanban className="size-5" aria-hidden="true" /></span>
                    <RunnerBadge state={project.runnerState} />
                  </div>
                  <h3 className="mt-5 truncate font-semibold text-slate-900">{project.name}</h3>
                  <p className="mt-1 truncate text-xs text-slate-500">{project.workspace ?? "尚未绑定 workspace"}</p>
                  <span className="mt-5 flex items-center gap-1 text-xs font-semibold text-indigo-600">打开项目 <ArrowRight className="size-3.5 transition group-hover:translate-x-1" aria-hidden="true" /></span>
                </Link>
              ))}
            </div>
          ) : (
            <EmptyState icon={<FolderKanban className="size-5" aria-hidden="true" />} title="还没有 Project" description="创建第一个 Project，并把它绑定到设备上的 workspace。" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setNewOpen(true)}>新建并开始</Button>} />
          )}
        </section>

        <section className="min-w-0">
          <div className="mb-4"><h2 className="text-lg font-semibold text-slate-900">近期活动</h2><p className="mt-1 text-sm text-slate-500">从最近的上下文继续</p></div>
          {conversationItems.length ? (
            <Card className="overflow-hidden">
              <div className="divide-y divide-slate-100">
                {conversationItems.slice(0, 8).map(conversation => {
                  const project = projectItems.find(item => item.id === conversation.projectId);
                  return (
                    <Link key={conversation.id} to={conversation.projectId ? `/p/${conversation.projectId}/c/${conversation.id}` : `/c/${conversation.id}`} className="flex items-center gap-3 px-4 py-4 transition hover:bg-slate-50">
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500"><Activity className="size-4" aria-hidden="true" /></span>
                      <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium text-slate-800">{conversation.title || "未命名会话"}</strong><span className="mt-0.5 block truncate text-xs text-slate-500">{project?.name ?? "独立 Chat"} · {formatRelative(conversation.updatedAt)}</span></span>
                      <ArrowRight className="size-4 shrink-0 text-slate-300" aria-hidden="true" />
                    </Link>
                  );
                })}
              </div>
            </Card>
          ) : (
            <EmptyState icon={<MessageCircle className="size-5" aria-hidden="true" />} title="暂无会话" description="创建会话后，最近活动会出现在这里。" />
          )}
        </section>
      </div>
      <NewConversationDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </div>
  );
}

function MetricCard({ icon, label, value, meta }: { icon: React.ReactNode; label: string; value: string | number; meta: string }) {
  return <Card className="p-5"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p><p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</p><p className="mt-2 text-xs text-slate-500">{meta}</p></div><span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</span></div></Card>;
}

export function RunnerBadge({ state }: { state: string }) {
  const detail = state === "ready" ? ["bg-emerald-50 text-emerald-700 ring-emerald-200", "已就绪"] : state === "busy" ? ["bg-amber-50 text-amber-700 ring-amber-200", "运行中"] : state === "draining" ? ["bg-amber-50 text-amber-700 ring-amber-200", "正在排空"] : ["bg-rose-50 text-rose-700 ring-rose-200", "未连接"];
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${detail[0]}`}><span className={`size-1.5 rounded-full ${state === "ready" ? "bg-emerald-500" : state === "busy" || state === "draining" ? "bg-amber-500" : "bg-rose-500"}`} />{detail[1]}</span>;
}

function formatRelative(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}
