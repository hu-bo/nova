import { Button } from '@/components/ui/button';
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog';
import { useIdentity } from '@/features/auth';
import {
  useConversationSnapshot,
  useConversationsQuery,
  useDeleteConversationMutation,
} from '@/features/conversations';
import { NewProjectDialog, useProjectSidebarInfo, useProjectsQuery } from '@/features/projects';
import { usePreferences } from '@/features/settings';
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router';
import { Menu, PanelLeftOpen, Plus, Search, X } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { SidebarContent } from './sidebar/sidebar';
import type { SidebarConversation } from './sidebar/sidebar.types';
import { useOpenNewConversation } from './sidebar/use-open-new-conversation';

const CommandPalette = lazy(() =>
  import('./command-palette').then((module) => ({ default: module.CommandPalette })),
);

/** 把 react-query 状态映射成侧栏列表需要的加载态。 */
function feedState(query: { isPending: boolean; isError: boolean }): 'loading' | 'error' | 'ready' {
  return query.isPending ? 'loading' : query.isError ? 'error' : 'ready';
}

export function WorkspaceShell() {
  const { identity, signOut } = useIdentity();
  const { preferences, update } = usePreferences();
  const location = useLocation();
  const navigate = useNavigate();
  const openNewConversation = useOpenNewConversation();
  const projectsQuery = useProjectsQuery();
  const conversationsQuery = useConversationsQuery({ limit: 100 });
  const removeMutation = useDeleteConversationMutation();
  const projects = projectsQuery.data?.items ?? [];
  const conversations = conversationsQuery.data?.items ?? [];
  const projectInfo = useProjectSidebarInfo(projects.map((project) => project.id));
  const [mobileOpen, setMobileOpen] = useState(false);
  const [projectCreatorOpen, setProjectCreatorOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [deleting, setDeleting] = useState<SidebarConversation | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDialogRef = useRef<HTMLDialogElement>(null);

  function newChat() {
    setMobileOpen(false);
    openNewConversation();
  }
  function newProject() {
    setMobileOpen(false);
    setProjectCreatorOpen(true);
  }
  function openSearch() {
    setMobileOpen(false);
    setSearchOpen(true);
  }

  useEffect(() => {
    setMobileOpen(false);
    setProjectCreatorOpen(false);
    setSearchOpen(false);
    setDeleting(null);
  }, [location.pathname]);

  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!dialog) return;
    if (mobileOpen && !dialog.open) dialog.showModal();
    if (!mobileOpen && dialog.open) dialog.close();
  }, [mobileOpen]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (event.isComposing || event.repeat || !(event.ctrlKey || event.metaKey) || event.altKey)
        return;
      if (event.key.toLowerCase() !== 'k') return;
      if (!searchOpen && document.querySelector('[role="dialog"], dialog[open]')) return;
      event.preventDefault();
      setSearchOpen((open) => !open);
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [searchOpen]);

  const activeConversationId = location.pathname.match(/^\/conversations\/([^/]+)/)?.[1];
  const activeSnapshot = useConversationSnapshot(activeConversationId ?? null);
  const activeConversation =
    activeSnapshot.data?.conversation ??
    conversations.find((item) => item.id === activeConversationId);
  const selectedProjectId =
    activeConversation?.projectId ??
    (location.search as { projectId?: string }).projectId ??
    location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  const sidebarProjects = projects.map((project) => ({
    id: project.id,
    name: project.name,
    ...projectInfo[project.id],
    runnerState: projectInfo[project.id]?.runnerState ?? 'unknown',
  }));
  const sidebarProps = {
    activeProjectId: selectedProjectId,
    projectsState: feedState(projectsQuery),
    conversationsState: feedState(conversationsQuery),
    projects: sidebarProjects,
    conversations,
    onNewChat: newChat,
    onNewProject: newProject,
    onSearch: openSearch,
    onCollapse: () => update({ sidebarCollapsed: true }),
    onNewProjectChat: (project: { id: string }) => {
      setMobileOpen(false);
      void navigate({ to: '/conversations', search: { projectId: project.id } });
    },
    onEditProject: (project: { id: string }) => {
      setMobileOpen(false);
      void navigate({ to: '/projects/$id', params: { id: project.id } });
    },
    onDeleteConversation: (conversation: SidebarConversation) => {
      setMobileOpen(false);
      removeMutation.reset();
      setDeleting(conversation);
    },
    onNavigate: () => setMobileOpen(false),
    identity: { displayName: identity?.displayName ?? null, userId: identity?.identityId ?? null },
    onLogout: signOut,
  };

  async function removeConversation() {
    if (!deleting) return;
    try {
      await removeMutation.mutateAsync(deleting.id);
      setDeleting(null);
      if (window.location.pathname === '/conversations/' + deleting.id) {
        void navigate({
          to: '/conversations',
          search: { projectId: deleting.projectId ?? undefined },
          replace: true,
        });
      }
    } catch {
      /* The dialog shows the mutation error and allows retry. */
    }
  }

  return (
    <div className="min-h-screen bg-white">
      <Button
        ref={menuButtonRef}
        variant="ghost"
        isIconOnly
        aria-label="打开导航"
        className="fixed top-3 left-3 z-30 lg:hidden"
        onPress={() => setMobileOpen(true)}
      >
        <Menu size={18} />
      </Button>
      {preferences.sidebarCollapsed && (
        <aside
          aria-label="收起的导航"
          className="fixed inset-y-0 left-0 z-40 hidden w-14 flex-col items-center gap-2 border-r border-slate-200 bg-slate-50/70 py-3 lg:flex"
        >
          <Button
            variant="ghost"
            isIconOnly
            aria-label="展开侧栏"
            aria-expanded={false}
            onPress={() => update({ sidebarCollapsed: false })}
          >
            <PanelLeftOpen size={17} />
          </Button>
          <Button variant="ghost" isIconOnly aria-label="新建会话" onPress={newChat}>
            <Plus size={17} />
          </Button>
          <Button variant="ghost" isIconOnly aria-label="快速查找" onPress={openSearch}>
            <Search size={17} />
          </Button>
        </aside>
      )}
      {!preferences.sidebarCollapsed && (
        <aside
          id="desktop-navigation"
          className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-slate-200 bg-slate-50/70 lg:flex"
        >
          <SidebarContent {...sidebarProps} />
        </aside>
      )}
      <dialog
        ref={mobileDialogRef}
        aria-label="移动端导航"
        className="m-0 h-dvh max-h-none w-[min(86vw,288px)] max-w-none overflow-hidden bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/35 lg:hidden"
        onCancel={() => setMobileOpen(false)}
        onClose={() => {
          if (!searchOpen && !projectCreatorOpen && !deleting) menuButtonRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setMobileOpen(false);
        }}
      >
        <aside className="relative flex h-full flex-col">
          <button
            autoFocus
            type="button"
            aria-label="关闭导航"
            className="absolute top-2 right-2 z-10 grid size-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
          <SidebarContent {...sidebarProps} />
        </aside>
      </dialog>
      <main className={'min-h-dvh ' + (preferences.sidebarCollapsed ? 'lg:pl-14' : 'lg:pl-64')}>
        <Suspense
          fallback={
            <p role="status" className="p-8 text-sm text-slate-500">
              正在加载页面…
            </p>
          }
        >
          <Outlet />
        </Suspense>
      </main>
      {projectCreatorOpen && (
        <Suspense fallback={null}>
          <NewProjectDialog open onClose={() => setProjectCreatorOpen(false)} />
        </Suspense>
      )}
      {searchOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            projects={sidebarProjects}
            conversations={conversations}
            onClose={() => setSearchOpen(false)}
            onNewChat={newChat}
            onNewProject={newProject}
          />
        </Suspense>
      )}
      <ConfirmationDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        title="删除会话"
        subject={deleting?.title || '未命名会话'}
        description="这段会话的消息和任务记录将被删除，删除后无法恢复。"
        confirmLabel="删除会话"
        pendingLabel="正在删除…"
        isPending={removeMutation.isPending}
        error={removeMutation.error}
        onConfirm={() => void removeConversation()}
      />
    </div>
  );
}
