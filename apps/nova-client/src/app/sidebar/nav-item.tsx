import { Link, useMatchRoute } from '@tanstack/react-router';
import { type ComponentPropsWithRef, type ReactNode } from 'react';

export function NavItem({
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
