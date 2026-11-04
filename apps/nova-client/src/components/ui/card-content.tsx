import { cn } from '@/lib/cn';
import { Card as HeroUICard } from '@heroui/react';
import type { ComponentProps } from 'react';

export function CardContent({ className, ...props }: ComponentProps<typeof HeroUICard.Content>) {
  return (
    <HeroUICard.Content
      data-slot="card-content"
      className={cn('px-5 pb-5', className)}
      {...props}
    />
  );
}
