import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ButtonGroup, ToggleButton } from '@heroui/react';
import {
  ArrowRight,
  Folder,
  Grid2X2,
  List,
  LoaderCircle,
  MessageCircle,
  Plus,
  Search,
  Settings2,
} from 'lucide-react';
import { useConversationsQuery } from '@/features/conversations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ErrorNotice } from '@/components/error-notice';
import { cn } from '@/lib/cn';
import { displayWorkspacePath } from '@/lib/workspace-path';
import { NewProjectDialog } from './new-project-dialog';
import { useProjectsQuery, useProjectSidebarInfo } from './project.queries';

const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' });
function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '—' : dateFormat.format(date);
}

type ProjectEnvironmentInfo = { bindingState: string; runnerState: string } | undefined;
const DOT_BY_RUNNER_STATE: Record<string, string> = {
  ready: 'bg-emerald-500',
  verified: 'bg-emerald-500',
  offline: 'bg-amber-500',
};
const LABEL_BY_RUNNER_STATE: Record<string, string> = {
  verified: 'SSH 已验证',
  ready: '设备在线',
  offline: '环境离线',
};

/** 项目卡片的环境徽章：文案先按绑定状态再看 Runner 状态，圆点颜色只跟随 Runner 状态。 */
function environmentBadge(info: ProjectEnvironmentInfo) {
  const dot = DOT_BY_RUNNER_STATE[info?.runnerState ?? ''] ?? 'bg-slate-300';
  if (info?.bindingState === 'loading') return { label: '读取环境…', dot };
  if (info?.bindingState === 'error') return { label: '环境读取失败', dot };
  if (info?.bindingState !== 'bound') return { label: '待配置环境', dot };
  return { label: LABEL_BY_RUNNER_STATE[info.runnerState] ?? '环境状态待确认', dot };
}

export function ProjectsPage() {
  const projectsQuery = useProjectsQuery();
  const conversationsQuery = useConversationsQuery({ limit: 100 });
  const navigate = useNavigate();
  const routeSearch = useSearch({ strict: false }) as { createProject?: boolean };
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'unbound'>('all');
  const [view, setView] = useState<'grid' | 'list'>('grid');
  const projects = projectsQuery.data?.items ?? [];
  const environments = useProjectSidebarInfo(projects.map((item) => item.id));
  const conversations = (conversationsQuery.data?.items ?? [])
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  useEffect(() => {
    if (!routeSearch.createProject) return;
    setCreatorOpen(true);
    void navigate({ to: '/projects', search: {}, replace: true });
  }, [routeSearch.createProject, navigate]);
  const term = search.trim().toLocaleLowerCase();
  const filtered = projects.filter((item) => {
    const environment = environments[item.id];
    if (!(item.name + (environment?.workspace ?? '')).toLocaleLowerCase().includes(term))
      return false;
    if (filter === 'active')
      return conversations.some((chat) => chat.projectId === item.id && chat.activeRunId);
    if (filter === 'unbound') return environment?.bindingState === 'unbound';
    return true;
  });
  const filterLoading =
    filter === 'active'
      ? conversationsQuery.isPending
      : filter === 'unbound' &&
        Object.values(environments).some((item) => item.bindingState === 'loading');
  const filterError =
    filter === 'active'
      ? conversationsQuery.error
      : filter === 'unbound' &&
        Object.values(environments).some((item) => item.bindingState === 'error');
  return (
    <div className="mx-auto max-w-6xl space-y-7 px-5 py-8 sm:px-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 pl-10 lg:pl-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">项目</h1>
          <p className="mt-2 text-sm text-slate-500">选择工作目录，继续会话，或开始一项新任务。</p>
        </div>
        <Button onPress={() => setCreatorOpen(true)}>
          <Plus size={16} />
          新建项目
        </Button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 sm:max-w-80">
          <Search
            size={16}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-slate-500"
          />
          <Input
            aria-label="搜索项目"
            placeholder="搜索项目或工作目录"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="w-full pl-9"
          />
        </label>
        <div className="flex flex-wrap items-center gap-1" aria-label="筛选项目">
          {(
            [
              { id: 'all', title: '全部' },
              { id: 'active', title: '执行中' },
              { id: 'unbound', title: '待配置' },
            ] as const
          ).map((item) => (
            <Button
              key={item.id}
              variant={filter === item.id ? 'secondary' : 'ghost'}
              aria-pressed={filter === item.id}
              onPress={() => setFilter(item.id)}
            >
              {item.title}
            </Button>
          ))}
        </div>
        <ButtonGroup className="ml-auto">
          <ToggleButton
            variant="ghost"
            isIconOnly
            size="sm"
            aria-label="网格视图"
            isSelected={view === 'grid'}
            onChange={() => setView('grid')}
          >
            <Grid2X2 size={16} />
          </ToggleButton>
          <ToggleButton
            variant="ghost"
            isIconOnly
            size="sm"
            aria-label="列表视图"
            isSelected={view === 'list'}
            onChange={() => setView('list')}
          >
            <List size={16} />
          </ToggleButton>
        </ButtonGroup>
      </div>
      {conversationsQuery.error && filter !== 'active' && (
        <p role="status" className="text-xs text-slate-500">
          最近会话暂时无法读取。
          <button
            type="button"
            className="ml-2 text-accent"
            onClick={() => void conversationsQuery.refetch()}
          >
            重试
          </button>
        </p>
      )}
      {projectsQuery.error ? (
        <ErrorNotice error={projectsQuery.error} onRetry={() => void projectsQuery.refetch()} />
      ) : projectsQuery.isPending || filterLoading ? (
        <div role="status" className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-52 animate-pulse rounded-2xl bg-slate-100" />
          ))}
          <span className="sr-only">正在读取项目</span>
        </div>
      ) : filterError ? (
        <div role="alert" className="rounded-xl border p-6 text-sm text-slate-600">
          筛选所需的数据暂时无法读取。
          <Button
            variant="ghost"
            onPress={() => {
              void conversationsQuery.refetch();
              void projectsQuery.refetch();
              setFilter('all');
            }}
          >
            返回全部项目
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 px-6 py-20 text-center">
          <Folder size={28} className="mx-auto text-slate-400" />
          <h2 className="mt-4 text-base font-medium text-slate-800">
            {projects.length ? '没有符合条件的项目' : '从你的工作目录开始'}
          </h2>
          <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-500">
            {projects.length
              ? '调整关键词或筛选条件，查看其他项目。'
              : '创建项目并绑定 Runner 或 SSH 环境，让会话在对应目录里工作。'}
          </p>
          <Button
            className="mt-5"
            variant="secondary"
            onPress={() => {
              if (projects.length) {
                setFilter('all');
                setSearch('');
              } else setCreatorOpen(true);
            }}
          >
            {projects.length ? '清除筛选' : '创建项目'}
          </Button>
        </div>
      ) : (
        <div
          className={cn(
            'grid gap-4',
            view === 'grid' ? 'md:grid-cols-2 xl:grid-cols-3' : 'grid-cols-1',
          )}
        >
          {filtered.map((project) => {
            const info = environments[project.id];
            const chats = conversations.filter((item) => item.projectId === project.id);
            const latest = chats[0];
            const activeCount = chats.filter((item) => item.activeRunId).length;
            const bound = info?.bindingState === 'bound';
            const badge = environmentBadge(info);
            return (
              <article
                key={project.id}
                className={cn(
                  'flex min-w-0 flex-col rounded-2xl border border-slate-200 p-5',
                  view === 'list' && 'sm:flex-row sm:items-center sm:gap-6',
                )}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <Folder size={18} className="shrink-0 text-slate-500" />
                    <h2 className="min-w-0 flex-1 truncate font-semibold text-slate-800">
                      <Link
                        to="/projects/$id"
                        params={{ id: project.id }}
                        className="hover:text-accent"
                      >
                        {project.name}
                      </Link>
                    </h2>
                    <Link
                      to="/projects/$id"
                      params={{ id: project.id }}
                      aria-label={'管理项目 ' + project.name}
                      className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <Settings2 size={16} />
                    </Link>
                  </div>
                  <p
                    className="mt-3 truncate text-xs text-slate-500"
                    title={info?.workspace ?? undefined}
                  >
                    {info?.workspace
                      ? displayWorkspacePath(info.workspace)
                      : '绑定环境后，可在目录中执行任务'}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="flex items-center gap-1.5">
                      <span className={'size-1.5 rounded-full ' + badge.dot} />
                      {badge.label}
                    </span>
                    {activeCount > 0 && (
                      <span className="flex items-center gap-1 text-accent">
                        <LoaderCircle size={12} className="animate-spin" />
                        {activeCount} 项执行中
                      </span>
                    )}
                  </div>
                  {latest && (
                    <p className="mt-4 flex min-w-0 items-center gap-1.5 text-xs text-slate-600">
                      <MessageCircle size={13} className="shrink-0" />
                      <span className="truncate">{latest.title || '未命名会话'}</span>
                    </p>
                  )}
                  {!latest && (
                    <p className="mt-4 text-xs text-slate-500">
                      {conversationsQuery.isPending
                        ? '正在读取最近会话…'
                        : conversationsQuery.error
                          ? '最近会话暂不可用'
                          : '还没有会话，开始第一项任务。'}
                    </p>
                  )}
                </div>
                <div
                  className={cn(
                    'mt-5 flex items-center justify-between gap-3 border-t border-slate-100 pt-4',
                    view === 'list' && 'sm:mt-0 sm:w-52 sm:shrink-0 sm:border-0 sm:pt-0',
                  )}
                >
                  <time dateTime={project.updatedAt} className="text-xs text-slate-500">
                    {formatDate(project.updatedAt)} 更新
                  </time>
                  {latest ? (
                    <Link
                      to="/conversations/$id"
                      params={{ id: latest.id }}
                      className="flex items-center gap-1.5 rounded-lg text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      继续会话
                      <ArrowRight size={14} />
                    </Link>
                  ) : (
                    <Link
                      to={bound ? '/conversations' : '/projects/$id'}
                      {...(bound
                        ? { search: { projectId: project.id } }
                        : { params: { id: project.id } })}
                      className="flex items-center gap-1.5 rounded-lg text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {bound ? '开始任务' : '配置环境'}
                      <ArrowRight size={14} />
                    </Link>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {projectsQuery.isSuccess && (
        <p className="text-xs text-slate-500">
          显示 {filtered.length} 个项目 · 项目和最近会话各读取最多 100 条
        </p>
      )}
      {creatorOpen && <NewProjectDialog open onClose={() => setCreatorOpen(false)} />}
    </div>
  );
}
