import { cn } from '@/lib/cn';
import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';

export function DialogHeader({
  className,
  children,
  icon,
  tone = 'accent',
  ...props
}: ComponentProps<'div'> & {
  icon?: ReactNode;
  tone?: 'accent' | 'danger';
}) {
  return (
    <HeroUIModal.Header
      data-slot="dialog-header"
      className={cn('px-6 pt-6 sm:px-7 sm:pt-7', className)}
      {...props}
    >
      <div className="flex items-start gap-3.5 pr-7">
        {icon && (
          <span
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-2xl [&_svg]:size-5',
              tone === 'danger'
                ? 'bg-danger-soft text-danger-soft-foreground'
                : 'bg-accent-soft text-accent-soft-foreground',
            )}
            aria-hidden="true"
          >
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1 self-center space-y-1">{children}</div>
      </div>
    </HeroUIModal.Header>
  );
}
