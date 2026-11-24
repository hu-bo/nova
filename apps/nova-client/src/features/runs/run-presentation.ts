import type { RunView } from '@nova/agent-ui-contracts';

/** 运行状态 → 文案与指示色（单表）：标题栏状态行与产物卡片的来源 Run 徽标共用。 */
export const runPresentation = {
  queued: { label: '等待运行', indicator: 'bg-accent' },
  running: { label: '正在运行', indicator: 'bg-accent' },
  waiting: { label: '等待输入', indicator: 'bg-amber-500' },
  paused: { label: '运行已暂停', indicator: 'bg-amber-500' },
  cancelling: { label: '正在请求停止', indicator: 'bg-accent' },
  succeeded: { label: '运行完成', indicator: 'bg-emerald-500' },
  budget_exhausted: { label: '预算耗尽，任务未完成', indicator: 'bg-amber-500' },
  failed: { label: '运行失败', indicator: 'bg-rose-500' },
  timed_out: { label: '运行超时', indicator: 'bg-rose-500' },
  cancelled: { label: '已停止', indicator: 'bg-slate-400' },
  cancelled_unconfirmed: { label: '需要核实', indicator: 'bg-amber-500' },
} satisfies Record<RunView['state'], { label: string; indicator: string }>;
