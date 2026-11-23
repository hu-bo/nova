import { SettingsDialog } from '@/components/ui/settings-dialog';
import { RunnerManager } from './runner-manager';

interface RunnerManagerDialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  selectedRunnerId?: string;
  onSelect?: (runnerId: string) => void | Promise<unknown>;
  onSelectRequest?: (runnerId: string) => void;
  selectionHint?: string;
}

export function RunnerManagerDialog({
  open,
  onClose,
  title = 'Runner 与连接令牌',
  selectedRunnerId,
  onSelect,
  onSelectRequest,
  selectionHint,
}: RunnerManagerDialogProps) {
  return (
    <SettingsDialog open={open} onClose={onClose} size="xl" title={title}>
      <RunnerManager
        onClose={onClose}
        {...(selectedRunnerId ? { selectedRunnerId } : {})}
        {...(onSelect ? { onSelect } : {})}
        {...(onSelectRequest ? { onSelectRequest } : {})}
        {...(selectionHint ? { selectionHint } : {})}
      />
    </SettingsDialog>
  );
}
export { RunnerManager } from './runner-manager';
