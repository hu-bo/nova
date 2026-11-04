import { WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-48 flex-col items-center justify-center rounded-xl bg-white px-6 py-10 text-center ring-1 ring-slate-200">
      <div className="mb-4 grid size-11 place-items-center rounded-xl bg-slate-100 text-slate-500">
        {icon ?? <WifiOff className="size-5" aria-hidden="true" />}
      </div>
      <h3 className="font-semibold text-slate-900">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
