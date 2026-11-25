import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from './button';
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
      onKeyDownCapture={(event) => {
        if (
          !enterToConfirm ||
          event.key !== 'Enter' ||
          event.nativeEvent.isComposing ||
          event.repeat ||
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        if (
          event.target instanceof HTMLElement &&
          (event.target.tagName === 'TEXTAREA' || event.target.isContentEditable)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        if (!isPending && !confirmDisabled)
          event.currentTarget.querySelector('form')?.requestSubmit();
      }}
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
