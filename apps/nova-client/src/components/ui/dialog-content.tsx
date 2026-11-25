import { cn } from '@/lib/cn';
import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';

export interface DialogContentProps extends Omit<
  ComponentProps<typeof HeroUIModal.Container>,
  'children'
> {
  children: ReactNode;
  showCloseButton?: boolean;
  dialogClassName?: string;
  closeDisabled?: boolean;
  onKeyDownCapture?: ComponentProps<'div'>['onKeyDownCapture'];
  dialogProps?: Omit<ComponentProps<typeof HeroUIModal.Dialog>, 'children' | 'className'>;
}

export function DialogContent({
  className,
  children,
  size = 'sm',
  showCloseButton = true,
  dialogClassName,
  closeDisabled = false,
  onKeyDownCapture,
  dialogProps,
  ...props
}: DialogContentProps) {
  return (
    <HeroUIModal.Container size={size} {...(className ? { className } : {})} {...props}>
      <HeroUIModal.Dialog
        {...dialogProps}
        className={cn('bg-surface p-0 text-surface-foreground', dialogClassName)}
      >
        <div className="contents" onKeyDownCapture={onKeyDownCapture}>
          {children}
        </div>
        {showCloseButton && (
          <HeroUIModal.CloseTrigger
            aria-label="关闭"
            isDisabled={closeDisabled}
            className="text-muted-foreground"
          />
        )}
      </HeroUIModal.Dialog>
    </HeroUIModal.Container>
  );
}
