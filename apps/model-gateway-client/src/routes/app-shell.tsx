import { BarChart3, Boxes, Gauge, KeyRound, LogOut, Menu, ServerCog, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/provider.js";

const navigation = [
  { to: "/providers", label: "Providers", description: "连接与凭据", icon: ServerCog },
  { to: "/models", label: "模型目录", description: "能力与价格", icon: Boxes },
  // { to: "/keys", label: "API Keys", description: "业务侧凭据", icon: KeyRound },
  { to: "/usage", label: "用量报表", description: "Token 与费用", icon: BarChart3 },
  { to: "/quotas", label: "配额策略", description: "速率与预算", icon: Gauge },
];

export function AppShell() {
  const auth = useAuth();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileDialogRef = useRef<HTMLDialogElement>(null);
  const active = navigation.find((item) => location.pathname.startsWith(item.to)) ?? navigation[0]!;

  useEffect(() => {
    const dialog = mobileDialogRef.current;
    if (!dialog) return;
    if (mobileOpen && !dialog.open) dialog.showModal();
    if (!mobileOpen && dialog.open) dialog.close();
  }, [mobileOpen]);

  return (
    <div className="min-h-screen bg-slate-50">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-slate-200 bg-white lg:flex lg:flex-col">
        <Brand />
        <Navigation onNavigate={() => setMobileOpen(false)} />
        <div className="mt-auto border-t border-slate-100 p-4">
          <div className="rounded-xl bg-slate-50 p-3 ring-1 ring-slate-200">
            <p className="truncate text-sm font-semibold text-slate-900">{auth.displayName || "管理员"}</p>
            <p className="mt-0.5 text-xs text-slate-500">Casdoor 管理会话</p>
            <button
              type="button"
              onClick={auth.logout}
              className="mt-3 flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-slate-600 transition hover:bg-white hover:text-slate-900"
            >
              <LogOut className="size-4" aria-hidden="true" />
              退出登录
            </button>
          </div>
        </div>
      </aside>

      <header className="fixed inset-x-0 top-0 z-20 flex h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-4 backdrop-blur lg:left-64 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 lg:hidden"
            aria-label="打开导航"
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen(true)}
          >
            <Menu className="size-5" aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">{active.label}</p>
            <p className="hidden text-xs text-slate-500 sm:block">模型配置管理 · 不在推理请求路径中</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">
          <span className="size-2 rounded-full bg-emerald-500" aria-hidden="true" />
          管理面
        </span>
      </header>

      <dialog
        ref={mobileDialogRef}
        aria-label="主导航"
        className="fixed inset-0 z-40 m-0 h-dvh max-h-none w-screen max-w-none bg-transparent p-0 backdrop:bg-transparent lg:hidden"
        onCancel={(event) => {
          event.preventDefault();
          setMobileOpen(false);
        }}
        onClose={() => setMobileOpen(false)}
      >
        <button
          type="button"
          className="absolute inset-y-0 right-0 left-[min(20rem,86vw)] bg-slate-950/40"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
        <aside className="relative flex h-full w-[min(20rem,86vw)] flex-col bg-white shadow-2xl">
          <div className="flex items-center justify-between">
            <Brand />
            <button
              type="button"
              className="mr-4 rounded-lg p-2 text-slate-500 hover:bg-slate-100"
              aria-label="关闭导航"
              onClick={() => setMobileOpen(false)}
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
          <Navigation onNavigate={() => setMobileOpen(false)} />
          <div className="mt-auto border-t border-slate-100 p-4">
            <button
              type="button"
              onClick={auth.logout}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100"
            >
              <LogOut className="size-4" aria-hidden="true" />
              退出登录
            </button>
          </div>
        </aside>
      </dialog>

      <main className="pt-16 lg:ml-64">
        <div className="mx-auto max-w-[1600px] p-5 sm:p-8 lg:p-10">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex h-20 items-center gap-3 px-5">
      <div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-sm font-black text-white shadow-sm">
        N
      </div>
      <div>
        <p className="font-bold tracking-tight text-slate-900">Nova Control</p>
        <p className="text-xs text-slate-500">Model configuration</p>
      </div>
    </div>
  );
}

function Navigation({ onNavigate }: { onNavigate: () => void }) {
  return (
    <nav className="space-y-1 px-3 py-3" aria-label="模型配置导航">
      {navigation.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-xl px-3 py-2.5 transition ${isActive ? "bg-indigo-50 text-indigo-700 ring-1 ring-indigo-100" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`
          }
        >
          <item.icon className="size-5 shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">{item.label}</span>
            <span className="block text-xs opacity-70">{item.description}</span>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
