import { Badge } from '@/components/ui/badge';
import { runnerStatus, type Runner } from '@/features/runners';

export function RunnerStateBadge({ runner }: { runner: Runner }) {
  const status = runnerStatus(runner);
  const variant = status === 'online' ? 'success' : status === 'revoked' ? 'danger' : 'warning';
  const label = status === 'online' ? '在线' : status === 'revoked' ? '已撤销' : '离线';
  return (
    <Badge variant={variant} className="shrink-0 gap-1 whitespace-nowrap px-2 py-0.5">
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
