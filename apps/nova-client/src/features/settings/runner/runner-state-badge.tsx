import { Badge, type BadgeProps } from '@/components/ui/badge';
import { runnerStatus, type Runner } from '@/features/runners';

const runnerStatusPresentation = {
  online: { label: '在线', variant: 'success' },
  revoked: { label: '已撤销', variant: 'danger' },
  offline: { label: '离线', variant: 'warning' },
} satisfies Record<
  ReturnType<typeof runnerStatus>,
  { label: string; variant: BadgeProps['variant'] }
>;

export function RunnerStateBadge({ runner }: { runner: Runner }) {
  const { label, variant } = runnerStatusPresentation[runnerStatus(runner)];
  return (
    <Badge variant={variant} className="shrink-0 gap-1 whitespace-nowrap px-2 py-0.5">
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {label}
    </Badge>
  );
}
