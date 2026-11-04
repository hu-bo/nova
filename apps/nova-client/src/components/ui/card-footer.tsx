import { cn } from '@/lib/cn';
import { Card as HeroUICard } from '@heroui/react';
import type { ComponentProps } from 'react';

export function CardFooter({ className, ...props }: ComponentProps<typeof HeroUICard.Footer>) {
  return (
    <HeroUICard.Footer
      data-slot="card-footer"
      className={cn('flex items-center px-5 pb-5', className)}
      {...props}
    />
  );
}
