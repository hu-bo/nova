import { Modal as HeroUIModal } from '@heroui/react';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface DialogProps {
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  isPending?: boolean;
}

export function Dialog({ open, onOpenChange, children, isPending = false }: DialogProps) {
  return (
    <HeroUIModal.Backdrop
      isOpen={open}
      onOpenChange={(next) => {
        if (!isPending) onOpenChange?.(next);
      }}
      isDismissable={!isPending}
      isKeyboardDismissDisabled={isPending}
      variant="blur"
      className="z-50"
    >
      {children}
    </HeroUIModal.Backdrop>
  );
}

export interface DialogContentProps extends Omit<
  ComponentProps<typeof HeroUIModal.Container>,
  'children'
> {
  children: ReactNode;
  showCloseButton?: boolean;
  dialogClassName?: string;
  closeDisabled?: boolean;
  dialogProps?: Omit<ComponentProps<typeof HeroUIModal.Dialog>, 'children' | 'className'>;
}

export function DialogContent({
  className,
  children,
  size = 'sm',
  showCloseButton = true,
  dialogClassName,
  closeDisabled = false,
  dialogProps,
  ...props
}: DialogContentProps) {
  return (
    <HeroUIModal.Container size={size} {...(className ? { className } : {})} {...props}>
      <HeroUIModal.Dialog
        {...dialogProps}
        className={cn('bg-surface p-0 text-surface-foreground', dialogClassName)}
      >
        {children}
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

export function DialogBody({ className, ...props }: ComponentProps<typeof HeroUIModal.Body>) {
  return (
    <HeroUIModal.Body
      data-slot="dialog-body"
      className={cn('space-y-5 px-6 py-5 text-foreground sm:px-7', className)}
      {...props}
    />
  );
}

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

export function DialogTitle({ className, ...props }: ComponentProps<typeof HeroUIModal.Heading>) {
  return (
    <HeroUIModal.Heading
      data-slot="dialog-title"
      className={cn('text-xl leading-7 font-semibold tracking-tight text-foreground', className)}
      {...props}
    />
  );
}

export function DialogDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-description"
      className={cn('text-sm leading-6 text-muted-foreground', className)}
      {...props}
    />
  );
}

/** Legacy portals / trigger / overlay aliases — preserved as no-op passes for callers
 * that imported them from the old shadcn-style wrapper. */
export function DialogPortal({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function DialogTrigger({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function DialogOverlay({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

export function DialogClose({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}
