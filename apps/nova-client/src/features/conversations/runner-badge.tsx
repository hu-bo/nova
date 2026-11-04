import { Badge } from '@/components/ui/badge';
import { runnerStatus, useRunnersQuery } from '@/features/runners';

const RUNNER_BADGE_BY_STATUS = {
  online: { variant: 'success', label: '设备在线' },
  revoked: { variant: 'danger', label: '凭据已撤销' },
  offline: { variant: 'warning', label: '设备未连接' },
} as const;

/** 项目会话头部的 Runner 状态徽章（参考 `pages/home.tsx` RunnerBadge）。 */
export function RunnerBadge({ runnerId }: { runnerId: string }) {
  const runners = useRunnersQuery();
  const runner = runners.data?.items.find(
    (item) => item.id === runnerId || item.runnerId === runnerId,
  );
  if (runners.isPending) return null;
  const detail = RUNNER_BADGE_BY_STATUS[runner ? runnerStatus(runner) : 'offline'];
  return (
    <Badge variant={detail.variant} className="shrink-0 gap-1 px-2 py-0.5 whitespace-nowrap">
      <span className="size-1.5 shrink-0 rounded-full bg-current" />
      {detail.label}
    </Badge>
  );
}
