import { useId, type ComponentProps, type ReactNode } from 'react';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';

type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const sizes: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-6xl',
};

export interface SettingsDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  tone?: 'accent' | 'danger';
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  onSubmit?: ComponentProps<'form'>['onSubmit'];
  isPending?: boolean;
  size?: DialogSize;
}

/** Settings and feature dialogs share the same HeroUI frame, spacing and dismissal rules. */
export function SettingsDialog({
  open,
  title,
  description,
  icon,
  tone = 'accent',
  children,
  footer,
  onClose,
  onSubmit,
  isPending = false,
  size = 'md',
}: SettingsDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const content = (
    <>
      <DialogHeader icon={icon} tone={tone}>
        <DialogTitle id={titleId}>{title}</DialogTitle>
        {description && <DialogDescription id={descriptionId}>{description}</DialogDescription>}
      </DialogHeader>
      <DialogBody>{children}</DialogBody>
      {footer && <DialogFooter>{footer}</DialogFooter>}
    </>
  );
  return (
    <Dialog
      open={open}
      isPending={isPending}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        size={size === 'xl' ? 'lg' : size}
        closeDisabled={isPending}
        dialogClassName={sizes[size]}
        dialogProps={{
          'aria-labelledby': titleId,
          ...(description ? { 'aria-describedby': descriptionId } : {}),
        }}
      >
        {onSubmit ? (
          <form onSubmit={onSubmit} className="flex min-h-0 flex-col">
            {content}
          </form>
        ) : (
          content
        )}
      </DialogContent>
    </Dialog>
  );
}
