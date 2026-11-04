import type { ComponentProps } from 'react';

export function TableHeader(props: ComponentProps<'thead'>) {
  return (
    <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500" {...props} />
  );
}
