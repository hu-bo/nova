import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export function TableHead({ className, ...props }: ComponentProps<'th'>) {
  return <th className={cn('px-4 py-3 font-semibold', className)} {...props} />;
}
