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
