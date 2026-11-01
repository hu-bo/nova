import { Popover } from '@base-ui/react/popover';
import { useLocation, useMatchRoute } from '@tanstack/react-router';
import {
  Folder,
  Search,
  ChevronRight,
  PanelLeftClose,
  LoaderCircle,
  LogOut,
  MessageCircle,
  Plus,
  Settings,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Link } from '@tanstack/react-router';
import { useState, type ComponentPropsWithRef, type ReactElement, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { displayWorkspacePath } from '@/lib/workspace-path';
import type { SidebarConversation, SidebarIdentity, SidebarProject } from './sidebar.types';

/**
 * 与源参考 `pages/app-shell.tsx` 中 `SidebarContent` 的整体视觉/交互一致。
 *
 * 差异点：
 * - React Router → TanStack Router：`NavLink` className 回调用 `useMatchRoute()` 替代。
 * - `useAuth` → 调用方传入 `identity`/`onLogout`。
 * - 项目级「正在处理」状态从 `useConversationStore(id).state.isRunning` 退化为读取
 *   当前已加载的 `conversation.activeRunId`（`null` 视为空闲）。
 * - `ProjectDetailsPopover` 使用 Base UI 原生悬停交互管理打开、关闭和浮层间的鼠标移动。
 */
export function SidebarContent({
  projects,
  conversations,
  onNewProject,
  onNewChat,
  onSearch,
  onCollapse,
  onNewProjectChat,
  onEditProject,
  onDeleteConversation,
  onNavigate,
  activeProjectId: contextProjectId,
  projectsState = 'ready',
  conversationsState = 'ready',
  identity,
  onLogout,
}: {
  projects: SidebarProject[];
  conversations: SidebarConversation[];
  onNewProject: () => void;
  onNewChat: () => void;
  onSearch: () => void;
  onCollapse: () => void;
  onNewProjectChat: (project: { id: string }) => void;
  onEditProject: (project: { id: string }) => void;
  onDeleteConversation: (conversation: SidebarConversation) => void;
  onNavigate?: () => void;
  activeProjectId?: string | null | undefined;
  projectsState?: 'loading' | 'error' | 'ready';
  conversationsState?: 'loading' | 'error' | 'ready';
  identity: SidebarIdentity;
  onLogout: () => void;
}) {
  const location = useLocation();
  const matchRoute = useMatchRoute();
  const userLabel = identity.displayName ?? 'Nova 用户';
  const avatarLabel = (identity.displayName ?? identity.userId ?? 'N').slice(0, 1).toUpperCase();
  const activeConversationMatch = matchRoute({ to: '/conversations/$id', fuzzy: false }) as
    { id?: string } | undefined;
  const activeProjectId =
    contextProjectId ??
    conversations.find((conversation) => conversation.id === activeConversationMatch?.id)
      ?.projectId ??
    (location.search as { projectId?: string }).projectId ??
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1] ??
    null;
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const chats = conversations.filter((conversation) => !conversation.projectId);
  const activeConversations = conversations.filter((conversation) => conversation.activeRunId);
  const visibleProjects = projects;
  return (
    <>
      <Link
        to="/"
        onClick={onNavigate}
        className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 px-4"
      >
        <span className="grid size-8 place-items-center rounded-xl bg-accent text-accent-foreground">
          <Sparkles size={18} />
        </span>
        <div>
          <strong className="block text-sm tracking-tight text-slate-900">Nova</strong>
          <span className="block text-[10px] font-medium uppercase tracking-[0.13em] text-slate-500">
            Coding workspace
          </span>
        </div>
      </Link>
      <Button
        variant="ghost"
        isIconOnly
        aria-label="收起侧栏"
        aria-expanded
        aria-controls="desktop-navigation"
        className="absolute top-3 right-3 hidden lg:inline-flex"
        onPress={onCollapse}
      >
        <PanelLeftClose size={17} />
      </Button>
      <div className="space-y-2 px-3 pb-1 pt-4">
        <Button
          variant="secondary"
          className="w-full justify-start"
          aria-label="新建普通会话"
          onPress={onNewChat}
        >
          <Plus size={16} />
          新建会话
        </Button>
        <Button
          variant="ghost"
          className="w-full justify-start text-slate-500"
          aria-label="搜索会话与项目"
          onPress={onSearch}
        >
          <Search size={15} />
          搜索会话与项目
          <kbd className="ml-auto text-[10px] text-slate-500">Ctrl K</kbd>
        </Button>
      </div>
      <nav className="min-h-0 flex-1 space-y-6 overflow-y-auto px-3 py-4" aria-label="主导航">
        <section>
          <div className="mb-2 flex items-center justify-between px-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-500">
              <MessageCircle size={14} />
              最近会话
            </h2>
            <Button variant="ghost" isIconOnly aria-label="新建会话" onPress={onNewChat}>
              <Plus size={14} />
            </Button>
          </div>
          <div className="space-y-0.5">
            {chats.map((conversation) => (
              <ConversationNavItem
                key={conversation.id}
                conversation={conversation}
                to={'/conversations/' + conversation.id}
                onClick={onNavigate}
                onDelete={onDeleteConversation}
              />
            ))}
          </div>
          {!chats.length && (
            <p className="px-2 py-2 text-xs leading-5 text-slate-500">
              {conversationsState === 'loading'
                ? '正在读取最近会话…'
                : conversationsState === 'error'
                  ? '最近会话暂时无法读取。'
                  : '从一个问题开始新的对话。'}
            </p>
          )}
        </section>
        <section aria-label="进行中">
          <div className="mb-2 flex items-center justify-between px-2">
            <h2 className="flex items-center gap-2 text-xs font-semibold text-slate-500">
              <LoaderCircle size={14} aria-hidden="true" />
              进行中
            </h2>
            {activeConversations.length > 0 && (
              <span className="text-xs tabular-nums text-slate-500">
                {activeConversations.length}
              </span>
            )}
          </div>
          <div className="space-y-0.5">
            {activeConversations.map((conversation) => (
              <ConversationNavItem
                key={conversation.id}
                conversation={conversation}
                to={'/conversations/' + conversation.id}
                onClick={onNavigate}
                onDelete={onDeleteConversation}
              />
            ))}
          </div>
          {!activeConversations.length && (
            <p className="px-2 py-2 text-xs leading-5 text-slate-500">
              {conversationsState === 'loading'
                ? '正在读取进行中的会话…'
                : conversationsState === 'error'
                  ? '进行中的会话暂时无法读取。'
                  : '暂无进行中的会话。'}
            </p>
          )}
        </section>
        <section>
          <div className="mb-2 flex items-center justify-between px-2">
            <Link
              to="/projects"
              onClick={onNavigate}
              className="flex items-center gap-2 text-xs font-semibold text-slate-500 hover:text-slate-900"
            >
              <Folder size={14} />
              项目
              <ChevronRight size={12} />
            </Link>
            <Button variant="ghost" isIconOnly aria-label="新建项目" onPress={onNewProject}>
              <Plus size={14} />
            </Button>
          </div>
          <div className="space-y-3">
            {visibleProjects.map((project) => {
              const tasks = conversations.filter(
                (conversation) => conversation.projectId === project.id,
              );
              const isCollapsed = collapsed[project.id] ?? activeProjectId !== project.id;
              return (
                <div key={project.id}>
                  <div className="flex min-w-0 items-center gap-0.5">
                    <button
                      type="button"
                      className="grid size-6 shrink-0 place-items-center rounded-md text-slate-500 hover:bg-slate-200/50"
                      aria-label={(isCollapsed ? '展开 ' : '收起 ') + project.name}
                      aria-expanded={!isCollapsed}
                      onClick={() =>
                        setCollapsed((current) => ({
                          ...current,
                          [project.id]: !isCollapsed,
                        }))
                      }
                    >
                      <ChevronRight size={13} className={isCollapsed ? '' : 'rotate-90'} />
                    </button>
                    <div className="min-w-0 flex-1">
                      <ProjectDetailsPopover
                        project={project}
                        taskCount={tasks.length}
                        onEdit={() => onEditProject(project)}
                      >
                        <NavItem
                          to="/projects/$id"
                          params={{ id: project.id }}
                          icon={
                            <span
                              className={'size-1.5 rounded-full ' + runnerDot(project.runnerState)}
                            />
                          }
                          label={project.name}
                          onClick={onNavigate}
                          contextActive={activeProjectId === project.id}
                        />
                      </ProjectDetailsPopover>
                    </div>
                    <Button
                      variant="ghost"
                      isIconOnly
                      aria-label={'在 ' + project.name + ' 中新建会话'}
                      onPress={() => onNewProjectChat(project)}
                    >
                      <Plus size={14} />
                    </Button>
                  </div>
                  {!isCollapsed && (
                    <div className="ml-3 mt-1 space-y-0.5 border-l border-slate-200 pl-2">
                      {tasks.map((conversation) => (
                        <ConversationNavItem
                          key={conversation.id}
                          conversation={conversation}
                          to={'/conversations/' + conversation.id}
                          onClick={onNavigate}
                          onDelete={onDeleteConversation}
                        />
                      ))}
                      {!tasks.length && (
                        <button
                          type="button"
                          className="w-full px-3 py-2 text-left text-xs text-slate-500 hover:text-accent"
                          onClick={() => onNewProjectChat(project)}
                        >
                          开始项目会话
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!visibleProjects.length && (
            <div className="px-2 py-2 text-xs leading-5 text-slate-500">
              {projectsState !== 'ready' ? (
                <p>{projectsState === 'loading' ? '正在读取项目…' : '项目暂时无法读取。'}</p>
              ) : (
                <>
                  <p>连接工作目录，整理项目会话。</p>
                  <button
                    type="button"
                    onClick={onNewProject}
                    className="mt-2 flex items-center gap-1 font-medium text-slate-500 hover:text-accent"
                  >
                    <Plus size={12} />
                    添加项目
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      </nav>
      <div className="shrink-0 border-t border-slate-200 px-3 py-2">
        <NavItem
          to="/settings/models"
          icon={<Settings size={16} />}
          label="设置"
          onClick={onNavigate}
        />
        <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-slate-200 px-2 pt-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
            {avatarLabel}
          </span>
          <p className="min-w-0 flex-1 truncate text-xs font-medium text-slate-600">{userLabel}</p>
          <Button variant="ghost" isIconOnly aria-label="退出登录" onPress={onLogout}>
            <LogOut size={15} />
          </Button>
        </div>
      </div>
    </>
  );
}

function ConversationNavItem({
  conversation,
  to,
  onClick,
  onDelete,
}: {
  conversation: SidebarConversation;
  to: string;
  onClick?: (() => void) | undefined;
  onDelete: (conversation: SidebarConversation) => void;
}) {
  const isRunning = Boolean(conversation.activeRunId);
  return (
    <div className="group relative">
      <NavItem
        to={to}
        icon={
          isRunning ? (
            <span className="relative flex size-4 items-center justify-center">
              <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              <span className="sr-only">正在处理中</span>
            </span>
          ) : (
            <MessageCircle className="size-4" aria-hidden="true" />
          )
        }
        label={conversation.title || '未命名会话'}
        onClick={onClick}
        className="pr-11"
      />
      <button
        type="button"
        className="absolute top-1/2 right-2 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-slate-500 opacity-100 lg:opacity-0 hover:bg-rose-50 hover:text-rose-600 group-hover:opacity-100 group-focus-within:opacity-100"
        disabled={isRunning}
        title={isRunning ? '任务执行中，请先停止运行' : '删除会话'}
        aria-label={`删除 ${conversation.title || '未命名会话'}`}
        onClick={() => onDelete(conversation)}
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}

function NavItem({
  to,
  icon,
  label,
  onClick,
  className,
  params,
  contextActive = false,
  ...linkProps
}: {
  to: string;
  icon: ReactNode;
  label: string;
  onClick?: (() => void) | undefined;
  className?: string | undefined;
  params?: Record<string, string> | undefined;
  contextActive?: boolean | undefined;
} & Omit<ComponentPropsWithRef<'a'>, 'onClick' | 'ref' | 'href' | 'target'> &
  Pick<ComponentPropsWithRef<typeof Link>, 'ref'>) {
  const matchRoute = useMatchRoute();
  const isActive = Boolean(matchRoute({ to, ...(params ? { params } : {}), fuzzy: true }));
  return (
    <Link
      {...linkProps}
      to={to}
      {...(params ? { params } : {})}
      {...(onClick ? { onClick } : {})}
      className={`flex min-w-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition ${
        isActive
          ? 'bg-slate-200/60 font-medium text-slate-950'
          : contextActive
            ? 'bg-slate-100 font-medium text-slate-800'
            : 'font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900'
      } ${className ?? ''}`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate">{label}</span>
    </Link>
  );
}

function runnerDot(state: string) {
  if (state === 'ready' || state === 'verified') return 'bg-emerald-500';
  if (state === 'busy' || state === 'draining') return 'bg-amber-500';
  return state === 'offline' ? 'bg-rose-500' : 'bg-slate-300';
}

function ProjectDetailsPopover({
  project,
  taskCount,
  children,
  onEdit,
}: {
  project: SidebarProject;
  taskCount: number;
  children: ReactElement;
  onEdit: () => void;
}) {
  return (
    <Popover.Root modal={false}>
      <Popover.Trigger
        render={children}
        nativeButton={false}
        role="link"
        openOnHover
        delay={250}
        closeDelay={150}
      />
      <Popover.Portal>
        <Popover.Positioner side="right" sideOffset={8} className="z-50">
          <Popover.Popup className="w-72 overflow-hidden rounded-2xl bg-white p-3 text-sm text-slate-700 shadow-xl ring-1 ring-slate-200/80">
            <div className="flex items-center gap-2 px-0.5 py-1.5 text-slate-950">
              <Folder className="size-5 shrink-0 text-slate-700" aria-hidden="true" />
              <Popover.Title className="min-w-0 truncate text-lg font-semibold">
                {project.name}
              </Popover.Title>
            </div>
            <div className="flex items-center gap-2 px-0.5 py-2.5">
              <MessageCircle className="size-5 shrink-0 text-slate-500" aria-hidden="true" />
              <span>{taskCount} 个任务</span>
            </div>
            <div className="border-t border-slate-200 py-2.5">
              <div className="flex items-start gap-2 px-0.5">
                <Folder className="mt-0.5 size-5 shrink-0 text-slate-500" aria-hidden="true" />
                <p className="min-w-0 break-all leading-5 text-slate-600">
                  {project.workspace
                    ? displayWorkspacePath(project.workspace)
                    : '尚未绑定 workspace'}
                </p>
              </div>
            </div>
            <div className="border-t border-slate-200 pt-1.5">
              <Popover.Close
                type="button"
                onClick={onEdit}
                className="flex w-full items-center gap-2 rounded-lg px-1.5 py-2 text-left font-medium text-slate-700 transition hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Settings2 className="size-5 text-slate-500" aria-hidden="true" />
                编辑项目
              </Popover.Close>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
