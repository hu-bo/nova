import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export function TableCell({ className, ...props }: ComponentProps<'td'>) {
  return <td className={cn('px-4 py-3.5 align-middle text-slate-600', className)} {...props} />;
}
