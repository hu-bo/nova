import { cn } from '@/lib/cn';
import { Card as HeroUICard } from '@heroui/react';
import type { ComponentProps } from 'react';

export function CardTitle({ className, ...props }: ComponentProps<typeof HeroUICard.Title>) {
  return (
    <HeroUICard.Title
      data-slot="card-title"
      className={cn('font-semibold leading-none text-foreground', className)}
      {...props}
    />
  );
}
