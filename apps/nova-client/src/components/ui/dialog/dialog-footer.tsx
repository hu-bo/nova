import { cn } from '@/lib/cn';
import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps } from 'react';

export function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <HeroUIModal.Footer
      data-slot="dialog-footer"
      className={cn(
        'mt-0 flex-row flex-wrap items-center justify-end gap-2 border-t border-separator px-6 py-4 sm:px-7',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <HeroUIModal.CloseTrigger className="text-sm font-medium text-muted-foreground outline-none transition hover:text-foreground">
          关闭
        </HeroUIModal.CloseTrigger>
      )}
    </HeroUIModal.Footer>
  );
}
