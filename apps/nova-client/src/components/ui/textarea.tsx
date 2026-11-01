import { TextArea as HeroUITextArea } from '@heroui/react';
import { cn } from '@/lib/cn';
import type { ComponentProps } from 'react';

export type TextareaProps = ComponentProps<typeof HeroUITextArea>;

export function Textarea({ className, ...props }: TextareaProps) {
  return (
    <HeroUITextArea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-xl border border-field-border bg-field-background px-3 py-2 text-sm text-field-foreground outline-none transition',
        'placeholder:text-field-placeholder',
        'focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus/30',
        'disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea as default };
