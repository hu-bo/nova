import { Input as HeroUIInput } from '@heroui/react';
import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export type InputProps = ComponentProps<typeof HeroUIInput>;

export function Input({ className, ...props }: InputProps) {
  return (
    <HeroUIInput
      data-slot="input"
      className={cn(
        'h-10 w-full rounded-xl border border-field-border bg-field-background px-3 text-sm text-field-foreground outline-none transition',
        'placeholder:text-field-placeholder',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus/30',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Input as default };
