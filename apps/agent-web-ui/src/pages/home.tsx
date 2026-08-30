import {
  Activity,
  ArrowRight,
  Check,
  Code2,
  FolderKanban,
  MessageCircle,
  MonitorCog,
  Plus,
  Server,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage } from "../api/client.js";
import { Button } from "../components/ui/button.js";
import { Card } from "../components/ui/card.js";
import { EmptyState, ErrorState, LoadingState } from "../components/ui/feedback.js";
import { displayWorkspacePath } from "../lib/workspace-path.js";
import { useQuickConversationCreate } from "./project/new-conversation.js";
import { useConversations, useProjects } from "./project/use-projects.js";
import { useRunnerCatalog } from "./settings/runner/use-runners.js";

export function HomeRoute() {
  const navigate = useNavigate();
  const createConversation = useQuickConversationCreate();
  const projects = useProjects();
  const conversations = useConversations();
  const runners = useRunnerCatalog();

  if (projects.isLoading || conversations.isLoading)
    return (
      <div className="p-6 lg:p-8">
        <LoadingState label="正在准备工作台" />
      </div>
    );
  if (projects.error)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState message={errorMessage(projects.error)} onRetry={() => void projects.refetch()} />
      </div>
    );
  if (conversations.error)
    return (
      <div className="p-6 lg:p-8">
        <ErrorState message={errorMessage(conversations.error)} onRetry={() => void conversations.refetch()} />
      </div>
    );

  const projectItems = projects.data ?? [];
  const conversationItems = conversations.data?.items ?? [];
  const createError = createConversation.error;
  const online = runners.runners.filter((runner) => runner.state === "ready" || runner.state === "busy").length;
  const recentConversations = conversationItems.slice(0, 5);

  return (
    <div className="mx-auto max-w-[1500px] p-5 sm:p-6 lg:p-8">
      {createError && (
        <p className="mb-6 rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-700 ring-1 ring-rose-200" role="alert">
          新建会话失败：{errorMessage(createError)}
        </p>
      )}
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div>
          <p className="text-sm font-semibold text-indigo-600">今天想完成什么？</p>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            从一个清晰的会话开始
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">
            直接讨论问题，或进入绑定了 Runner 与 workspace 的 Project 完成真实代码任务。
          </p>
        </div>
        <Button
          variant="primary"
          disabled={createConversation.isPending}
          icon={<Plus className="size-4" aria-hidden="true" />}
          onClick={() => createConversation.mutate(undefined)}
        >
          {createConversation.isPending ? "正在创建…" : "新建会话"}
        </Button>
      </div>

      <section className="mt-8 grid gap-4 sm:grid-cols-3" aria-label="工作台指标">
        <MetricCard
          icon={<FolderKanban className="size-5" aria-hidden="true" />}
          label="Projects"
          value={projectItems.length}
          meta="固定 workspace 边界"
          onClick={() => document.querySelector("#projects-section")?.scrollIntoView({ behavior: "smooth" })}
        />
        <MetricCard
          icon={<MessageCircle className="size-5" aria-hidden="true" />}
          label="最近会话"
          value={conversationItems.length}
          meta="最多显示 100 条"
          onClick={() => document.querySelector("#recent-activity-section")?.scrollIntoView({ behavior: "smooth" })}
        />
        <MetricCard
          icon={<Server className="size-5" aria-hidden="true" />}
          label="Runner 就绪"
          value={`${online}/${runners.runners.length}`}
          meta={online ? "可以开始执行" : "需要连接设备"}
          to="/settings/runners"
        />
      </section>

      <div className="mt-8 grid min-w-0 gap-8 xl:grid-cols-[1.2fr_0.8fr]">
        <section id="projects-section" className="min-w-0">
          <div className="mb-4 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">Projects</h2>
              <p className="mt-1 text-sm text-slate-500">选择一个 workspace 继续工作</p>
            </div>
          </div>
          {projectItems.length ? (
            <Card className="divide-y divide-slate-100 overflow-hidden">
              {projectItems.map((project) => (
                <Link
                  key={project.id}
                  to={`/p/${project.id}`}
                  className="group flex min-w-0 items-center gap-4 px-4 py-3.5 transition hover:bg-slate-50 sm:px-5"
                >
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-slate-100 text-slate-600 transition group-hover:bg-indigo-50 group-hover:text-indigo-600">
                    <FolderKanban className="size-5" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-semibold text-slate-900">{project.name}</h3>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {project.workspace ? displayWorkspacePath(project.workspace) : "尚未绑定 workspace"}
                    </p>
                  </div>
                  <RunnerBadge state={project.runnerState} />
                  <ArrowRight
                    className="size-4 shrink-0 text-slate-400 transition group-hover:translate-x-1 group-hover:text-indigo-600"
                    aria-hidden="true"
                  />
                </Link>
              ))}
            </Card>
          ) : (
            <EmptyState
              icon={<FolderKanban className="size-5" aria-hidden="true" />}
              title="还没有 Project"
              description="创建第一个 Project，并把它绑定到设备上的 workspace。"
              action={
                <Button
                  variant="primary"
                  icon={<Plus className="size-4" />}
                  onClick={() => navigate("/app?createProject=1")}
                >
                  新建 Project
                </Button>
              }
            />
          )}
        </section>

        <section id="recent-activity-section" className="min-w-0">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-900">近期活动</h2>
            <p className="mt-1 text-sm text-slate-500">从最近的上下文继续</p>
          </div>
          {conversationItems.length ? (
            <Card className="overflow-hidden">
              <div className="divide-y divide-slate-100">
                {recentConversations.map((conversation) => {
                  const project = projectItems.find((item) => item.id === conversation.projectId);
                  return (
                    <Link
                      key={conversation.id}
                      to={
                        conversation.projectId
                          ? `/p/${conversation.projectId}/c/${conversation.id}`
                          : `/c/${conversation.id}`
                      }
                      className="flex items-center gap-3 px-4 py-4 transition hover:bg-slate-50"
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500">
                        <Activity className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate text-sm font-medium text-slate-800">
                          {conversation.title || "未命名会话"}
                        </strong>
                        <span className="mt-0.5 block truncate text-xs text-slate-500">
                          {project?.name ?? "独立 Chat"} · {formatRelative(conversation.updatedAt)}
                        </span>
                      </span>
                      <ArrowRight className="size-4 shrink-0 text-slate-300" aria-hidden="true" />
                    </Link>
                  );
                })}
              </div>
            </Card>
          ) : (
            <EmptyState
              icon={<MessageCircle className="size-5" aria-hidden="true" />}
              title="暂无会话"
              description="创建会话后，最近活动会出现在这里。"
            />
          )}
        </section>
      </div>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  meta,
  to,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  meta: string;
  to?: string;
  onClick?: () => void;
}) {
  const content = (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">{value}</p>
          <p className="mt-2 text-xs text-slate-500">{meta}</p>
        </div>
        <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</span>
      </div>
    </Card>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
        style={{ position: "relative", zIndex: 10 }}
      >
        {content}
      </Link>
    );
  }
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-indigo-500"
      >
        {content}
      </button>
    );
  }
  return content;
}

function WorkflowCard({
  completed,
  number,
  title,
  description,
  icon,
  action,
  onClick,
  disabled = false,
}: {
  completed: boolean;
  number: string;
  title: string;
  description: string;
  icon: React.ReactNode;
  action: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  const content = (
    <div className="flex h-full flex-col">
      <div className="flex items-start justify-between gap-4">
        <span className="grid size-10 place-items-center rounded-xl bg-indigo-50 text-indigo-600">{icon}</span>
        <span
          className={`grid size-7 place-items-center rounded-full text-xs font-bold ${completed ? "bg-emerald-100 text-emerald-700" : "bg-indigo-100 text-indigo-700"}`}
        >
          {completed ? <Check className="size-4" /> : number}
        </span>
      </div>
      <strong className="mt-5 block text-sm text-slate-800">{title}</strong>
      <span className="mt-1 block text-sm leading-6 text-slate-500">{description}</span>
      <span className="mt-5 flex items-center gap-1 text-xs font-semibold text-indigo-600">
        {action} <ArrowRight className="size-3.5 transition group-hover:translate-x-1" aria-hidden="true" />
      </span>
    </div>
  );
  const className =
    "group block h-full rounded-xl bg-slate-50 p-5 text-left ring-1 ring-slate-100 transition hover:-translate-y-0.5 hover:bg-indigo-50 hover:ring-indigo-100";
  return (
    <li>
      <button type="button" className={`w-full ${className}`} onClick={onClick} disabled={disabled}>
        {content}
      </button>
    </li>
  );
}

export function RunnerBadge({ state }: { state: string }) {
  const detail =
    state === "ready"
      ? ["bg-emerald-50 text-emerald-700 ring-emerald-200", "已就绪"]
      : state === "busy"
        ? ["bg-amber-50 text-amber-700 ring-amber-200", "运行中"]
        : state === "draining"
          ? ["bg-amber-50 text-amber-700 ring-amber-200", "正在排空"]
          : ["bg-rose-50 text-rose-700 ring-rose-200", "未连接"];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ring-1 ${detail[0]}`}
    >
      <span
        className={`size-1.5 rounded-full ${state === "ready" ? "bg-emerald-500" : state === "busy" || state === "draining" ? "bg-amber-500" : "bg-rose-500"}`}
      />
      {detail[1]}
    </span>
  );
}

function formatRelative(timestamp: number) {
  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}
