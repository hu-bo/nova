import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export function DialogDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-description"
      className={cn('text-sm leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}
