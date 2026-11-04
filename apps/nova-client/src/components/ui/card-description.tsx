import { cn } from '@/lib/cn';
import { Card as HeroUICard } from '@heroui/react';
import type { ComponentProps } from 'react';

export function CardDescription({
  className,
  ...props
}: ComponentProps<typeof HeroUICard.Description>) {
  return (
    <HeroUICard.Description
      data-slot="card-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}
