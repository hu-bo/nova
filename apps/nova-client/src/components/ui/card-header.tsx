import { cn } from '@/lib/cn';
import { Card as HeroUICard } from '@heroui/react';
import type { ComponentProps } from 'react';

export function CardHeader({ className, ...props }: ComponentProps<typeof HeroUICard.Header>) {
  return (
    <HeroUICard.Header
      data-slot="card-header"
      className={cn('grid gap-1.5 px-5 pt-5', className)}
      {...props}
    />
  );
}
