import { Button } from '@/components/ui/button';
import type { RunView } from '@nova/agent-ui-contracts';
import { isActiveRun } from './run-event-reducer';
import type { RunControls } from './run-controls';
import type { RunStreamSnapshot } from './run-stream-manager';
const runPresentation = {
  queued: { label: '等待运行', indicator: 'bg-accent' },
  running: { label: '正在运行', indicator: 'bg-accent' },
  waiting: { label: '等待输入', indicator: 'bg-amber-500' },
  paused: { label: '运行已暂停', indicator: 'bg-amber-500' },
  cancelling: { label: '正在请求停止', indicator: 'bg-accent' },
  succeeded: { label: '运行完成', indicator: 'bg-emerald-500' },
  failed: { label: '运行失败', indicator: 'bg-rose-500' },
  timed_out: { label: '运行超时', indicator: 'bg-rose-500' },
  cancelled: { label: '已停止', indicator: 'bg-slate-400' },
  cancelled_unconfirmed: { label: '需要核实', indicator: 'bg-amber-500' },
} satisfies Record<RunView['state'], { label: string; indicator: string }>;
const connections = {
  connecting: '正在连接',
  live: '实时连接',
  reconnecting: '正在重连',
  offline: '连接已断开',
} satisfies Record<RunStreamSnapshot['state'], string>;

/**
 * 会话标题栏的运行状态指示（与参考实现一致，放在任务详情开关左侧）。
 * 从 `RunPanel` 的状态行抽出：连接状态点、运行状态文字、重连倒计时与停止按钮，
 * 让正文区不再为状态单独占一行。
 */
export function RunStatus({
  stream,
  controls,
  onRetry,
  executionEnabled,
}: {
  stream: RunStreamSnapshot;
  controls: RunControls;
  onRetry: () => void;
  executionEnabled: boolean;
}) {
  const projection = stream.projection;
  const { cancelling, now } = controls;
  const run = projection?.run;
  const presentation = run ? runPresentation[run.state] : null;
  const indicator =
    stream.state === 'live' ? (presentation?.indicator ?? 'bg-slate-400') : 'bg-amber-500';
  let statusLabel = presentation?.label ?? '';
  if (run) {
    if (cancelling && isActiveRun(run.state)) {
      statusLabel = '正在请求停止，等待设备确认';
    } else if (run.reason === 'RUNNER_OFFLINE') {
      statusLabel = '设备离线，运行已暂停';
    }
  }
  if (!projection?.run && stream.state === 'live') return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span className="flex items-center gap-2">
        <span className={'size-1.5 rounded-full ' + indicator} />
        {stream.state === 'live' ? '' : connections[stream.state]}
      </span>
      {run && (
        <span role="status" className="font-medium">
          {statusLabel}
        </span>
      )}
      {stream.state === 'offline' && (
        <Button
          variant="ghost"
          size="sm"
          disabled={Boolean(stream.retryAt && stream.retryAt > now)}
          onPress={onRetry}
        >
          {stream.retryAt && stream.retryAt > now
            ? `${Math.ceil((stream.retryAt - now) / 1000)} 秒后重试`
            : '重新连接'}
        </Button>
      )}
      {projection?.run && isActiveRun(projection.run.state) && (
        <Button
          variant="destructive"
          size="sm"
          disabled={!executionEnabled || cancelling}
          onPress={() => controls.cancel.mutate()}
        >
          停止运行
        </Button>
      )}
    </div>
  );
}
