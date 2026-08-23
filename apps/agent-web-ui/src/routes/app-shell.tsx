import { LayoutDashboard, LogOut, Menu, MessageCircle, Plus, Settings, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/provider.js";
import { useConversations, useProjects } from "../project/use-projects.js";
import { RunnerLiveUpdates } from "../runner/live-updates.js";
import { NewConversationDialog } from "../project/new-conversation.js";
import { NewProjectDrawer } from "../project/new-project.js";

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [creator, setCreator] = useState<"chat" | "project" | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const mobileDialogRef = useRef<HTMLDialogElement>(null);
  const auth = useAuth();
  const projects = useProjects();
  const conversations = useConversations();
  const location = useLocation();

  function openCreator(kind: "chat" | "project") {
    setMobileOpen(false);
    setCreator(kind);
  }

  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!dialog) return;
    if (mobileOpen && !dialog.open) dialog.showModal();
    if (!mobileOpen && dialog.open) dialog.close();
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-slate-50">
      <RunnerLiveUpdates />
      <header className="fixed inset-x-0 top-0 z-30 flex h-14 items-center border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur lg:left-64 lg:px-6">
        <button ref={menuButtonRef} type="button" className="mr-2 grid size-11 shrink-0 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 lg:hidden" aria-label="打开导航" onClick={() => setMobileOpen(true)}>
          <Menu className="size-5" aria-hidden="true" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-slate-900">{pageName(location.pathname, projects.data)}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="hidden text-right sm:block">
            <span className="block text-xs font-semibold text-slate-800">{auth.displayName ?? "Nova 用户"}</span>
          </span>
          <span className="grid size-9 place-items-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700" aria-hidden="true">
            {(auth.displayName ?? auth.userId ?? "N").slice(0, 1).toUpperCase()}
          </span>
        </div>
      </header>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col border-r border-slate-200 bg-white lg:flex">
        <SidebarContent projects={projects.data ?? []} conversations={conversations.data?.items ?? []} onNewProject={() => openCreator("project")} onNewChat={() => openCreator("chat")} onLogout={auth.logout} />
      </aside>

      <dialog
        ref={mobileDialogRef}
        aria-label="移动端导航"
        className="m-0 h-dvh max-h-none w-[min(82vw,288px)] max-w-none overflow-hidden bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-950/35 lg:hidden"
        onCancel={() => setMobileOpen(false)}
        onClose={() => menuButtonRef.current?.focus()}
        onClick={event => { if (event.target === event.currentTarget) setMobileOpen(false); }}
      >
        <aside className="relative flex h-full flex-col">
          <button autoFocus type="button" aria-label="关闭导航" className="absolute right-2 top-2 grid size-11 place-items-center rounded-lg text-slate-500 hover:bg-slate-100" onClick={() => setMobileOpen(false)}>
            <X className="size-5" aria-hidden="true" />
          </button>
          <SidebarContent projects={projects.data ?? []} conversations={conversations.data?.items ?? []} onNewProject={() => openCreator("project")} onNewChat={() => openCreator("chat")} onNavigate={() => setMobileOpen(false)} onLogout={auth.logout} />
        </aside>
      </dialog>

      <main className="min-h-screen pt-14 lg:pl-64">
        <Outlet />
      </main>
      <NewConversationDialog open={creator === "chat"} initialMode="chat" onClose={() => setCreator(null)} />
      <NewProjectDrawer open={creator === "project"} onClose={() => setCreator(null)} />
    </div>
  );
}

function SidebarContent({ projects, conversations, onNewProject, onNewChat, onNavigate, onLogout }: { projects: { id: string; name: string; runnerState: string }[]; conversations: { id: string; title: string; projectId: string | null }[]; onNewProject: () => void; onNewChat: () => void; onNavigate?: () => void; onLogout: () => void }) {
  return (
    <>
      <div className="flex h-16 items-center gap-3 border-b border-slate-100 px-5">
        <span className="grid size-9 place-items-center rounded-xl bg-indigo-600 text-white shadow-sm"><Sparkles className="size-5" aria-hidden="true" /></span>
        <div>
          <strong className="block text-sm tracking-tight text-slate-950">Nova</strong>
          <span className="block text-[11px] font-medium uppercase tracking-[0.16em] text-slate-400">Coding Agent</span>
        </div>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-3 py-5" aria-label="主导航">
        <div className="space-y-1">
          <NavItem to="/app" icon={<LayoutDashboard className="size-4" aria-hidden="true" />} label="工作台" onClick={onNavigate} />
          <NavItem to="/settings" icon={<Settings className="size-4" aria-hidden="true" />} label="设置" onClick={onNavigate} />
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between px-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">项目</span>
            <button type="button" onClick={onNewProject} className="grid size-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800" aria-label="新建项目" title="新建项目"><Plus className="size-4" aria-hidden="true" /></button>
          </div>
          <div className="space-y-1">
            {projects.slice(0, 12).map(project => (
              <NavItem
                key={project.id}
                to={`/p/${project.id}`}
                icon={<span className={`size-2 rounded-full ${runnerDot(project.runnerState)}`} aria-label={`Runner ${project.runnerState}`} />}
                label={project.name}
                onClick={onNavigate}
              />
            ))}
            {!projects.length && <p className="px-3 py-2 text-xs leading-5 text-slate-400">创建 Project 后会显示在这里。</p>}
          </div>
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between px-3">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">最近</span>
            <button type="button" onClick={onNewChat} className="grid size-7 place-items-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800" aria-label="新建普通会话" title="新建普通会话"><Plus className="size-4" aria-hidden="true" /></button>
          </div>
          <div className="space-y-1">
            {conversations.slice(0, 20).map(conversation => (
              <NavItem
                key={conversation.id}
                to={conversation.projectId ? `/p/${conversation.projectId}/c/${conversation.id}` : `/c/${conversation.id}`}
                icon={<MessageCircle className="size-4" aria-hidden="true" />}
                label={conversation.title || "未命名会话"}
                onClick={onNavigate}
              />
            ))}
            {!conversations.length && <p className="px-3 py-2 text-xs leading-5 text-slate-400">最近会话会显示在这里。</p>}
          </div>
        </div>
      </nav>
      <div className="border-t border-slate-100 p-3">
        <button type="button" onClick={onLogout} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-900">
          <LogOut className="size-4" aria-hidden="true" />退出登录
        </button>
      </div>
    </>
  );
}

function NavItem({ to, icon, label, onClick }: { to: string; icon: React.ReactNode; label: string; onClick?: (() => void) | undefined }) {
  return (
    <NavLink
      to={to}
      onClick={onClick}
      className={({ isActive }) => `flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${isActive ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"}`}
    >
      <span className="shrink-0">{icon}</span><span className="truncate">{label}</span>
    </NavLink>
  );
}

function runnerDot(state: string) {
  if (state === "ready") return "bg-emerald-500";
  if (state === "busy" || state === "draining") return "bg-amber-500";
  return "bg-rose-500";
}

function pageName(pathname: string, projects: { id: string; name: string }[] | undefined) {
  if (pathname === "/app") return "工作台";
  if (pathname === "/settings") return "设置";
  const projectId = pathname.match(/^\/p\/([^/]+)/)?.[1];
  if (projectId) return projects?.find(project => project.id === projectId)?.name ?? "Project";
  if (pathname.startsWith("/c/")) return "独立 Chat";
  return "Nova";
}
