import { Trash2 } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '../button';
import { SettingsDialog } from './settings-dialog';

export function ConfirmationDialog({
  open,
  title,
  description,
  subject,
  confirmLabel,
  pendingLabel = '正在处理…',
  onClose,
  onConfirm,
  isPending = false,
  confirmDisabled = false,
  enterToConfirm = false,
  error,
  children,
  icon = <Trash2 />,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  subject?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  onClose: () => void;
  onConfirm: () => void;
  isPending?: boolean;
  confirmDisabled?: boolean;
  enterToConfirm?: boolean;
  error?: unknown;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (!open || !enterToConfirm) return;

    function confirmOnEnter(event: KeyboardEvent) {
      if (
        event.key !== 'Enter' ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const target = event.target;
      const dialog = formRef.current?.closest('[role="dialog"]');
      if (!(target instanceof HTMLElement) || !dialog?.contains(target)) return;
      if (target.tagName === 'TEXTAREA' || target.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      if (!isPending && !confirmDisabled) formRef.current?.requestSubmit();
    }

    document.addEventListener('keydown', confirmOnEnter, true);
    return () => document.removeEventListener('keydown', confirmOnEnter, true);
  }, [open, enterToConfirm, isPending, confirmDisabled]);

  return (
    <SettingsDialog
      open={open}
      onClose={onClose}
      title={title}
      icon={icon}
      tone="danger"
      size="md"
      isPending={isPending}
      onSubmit={(event) => {
        event.preventDefault();
        if (!isPending && !confirmDisabled) onConfirm();
      }}
      formRef={formRef}
      footer={
        <>
          <Button variant="ghost" disabled={isPending} onPress={onClose}>
            取消
          </Button>
          <Button type="submit" variant="danger" disabled={isPending || confirmDisabled}>
            {isPending ? pendingLabel : confirmLabel}
          </Button>
        </>
      }
    >
      {subject && (
        <div className="break-words rounded-xl border border-border bg-surface-secondary/40 px-4 py-3 text-sm font-medium text-foreground">
          {subject}
        </div>
      )}
      <p className="text-sm leading-6 text-muted-foreground">{description}</p>
      {children}
      {error != null && <ErrorNotice error={error} />}
    </SettingsDialog>
  );
}
