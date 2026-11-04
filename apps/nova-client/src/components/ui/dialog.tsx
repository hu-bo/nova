import { Modal as HeroUIModal } from '@heroui/react';
import type { ReactNode } from 'react';

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
export { DialogBody } from './dialog-body';
export { DialogClose } from './dialog-close';
export { DialogContent } from './dialog-content';
export type { DialogContentProps } from './dialog-content';
export { DialogDescription } from './dialog-description';
export { DialogFooter } from './dialog-footer';
export { DialogHeader } from './dialog-header';
export { DialogOverlay } from './dialog-overlay';
export { DialogPortal } from './dialog-portal';
export { DialogTitle } from './dialog-title';
export { DialogTrigger } from './dialog-trigger';
