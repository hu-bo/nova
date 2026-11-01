import { Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { Cpu, Server, Terminal } from 'lucide-react';

const sections = [
  { to: '/settings/models', label: '模型与 Provider', icon: Cpu },
  { to: '/settings/runners', label: 'Runner 管理', icon: Server },
  { to: '/settings/remotes', label: 'SSH 远程', icon: Terminal },
] as const;

export function SettingsLayout() {
  const matchRoute = useMatchRoute();
  return (
    <div className="grid min-h-dvh grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[220px_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)]">
      <aside className="border-b border-slate-200 bg-slate-50/50 px-3 py-4 md:border-r md:border-b-0 md:py-6">
        <h1 className="mb-4 pr-3 pl-12 text-base font-semibold tracking-tight lg:pl-3">
          工作台设置
        </h1>
        <nav aria-label="设置分类" className="flex gap-1 overflow-x-auto md:flex-col">
          {sections.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              className={
                'flex shrink-0 items-center gap-2 rounded-xl px-3 py-2.5 text-sm ' +
                (matchRoute({ to, fuzzy: false })
                  ? 'bg-accent-soft font-semibold text-accent-soft-foreground'
                  : 'text-slate-500 hover:bg-slate-100')
              }
            >
              <Icon size={17} />
              {label}
            </Link>
          ))}
        </nav>
      </aside>
      <section className="min-w-0 px-5 py-6 sm:px-8">
        <div className="mx-auto max-w-5xl">
          <Outlet />
        </div>
      </section>
    </div>
  );
}
