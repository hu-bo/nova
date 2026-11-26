import { cn } from '@/lib/cn';
import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps } from 'react';

export function DialogBody({ className, ...props }: ComponentProps<typeof HeroUIModal.Body>) {
  return (
    <HeroUIModal.Body
      data-slot="dialog-body"
      className={cn('space-y-5 px-6 py-5 text-foreground sm:px-7', className)}
      {...props}
    />
  );
}
