import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export function TableRow({ className, ...props }: ComponentProps<'tr'>) {
  return <tr className={cn('transition-colors hover:bg-slate-50/80', className)} {...props} />;
}
