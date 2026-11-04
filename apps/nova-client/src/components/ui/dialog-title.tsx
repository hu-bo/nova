import { cn } from '@/lib/cn';
import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps } from 'react';

export function DialogTitle({ className, ...props }: ComponentProps<typeof HeroUIModal.Heading>) {
  return (
    <HeroUIModal.Heading
      data-slot="dialog-title"
      className={cn('text-xl leading-7 font-semibold tracking-tight text-foreground', className)}
      {...props}
    />
  );
}
