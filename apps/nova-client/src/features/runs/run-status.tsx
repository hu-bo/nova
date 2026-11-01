import { Button } from '@/components/ui/button';
import { isActiveRun } from './run-event-reducer';
import type { RunControls } from './run-controls';
import type { RunStreamSnapshot } from './run-stream-manager';
const states: Record<string, string> = {
  queued: '等待运行',
  running: '正在运行',
  waiting: '等待输入',
  paused: '运行已暂停',
  cancelling: '正在请求停止',
  succeeded: '运行完成',
  failed: '运行失败',
  timed_out: '运行超时',
  cancelled: '已停止',
  cancelled_unconfirmed: '需要核实',
};
const connections = {
  connecting: '正在连接',
  live: '实时连接',
  reconnecting: '正在重连',
  offline: '连接已断开',
};

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
  const runState = projection?.run?.state;
  const indicator =
    stream.state !== 'live' ||
    runState === 'waiting' ||
    runState === 'paused' ||
    runState === 'cancelled_unconfirmed'
      ? 'bg-amber-500'
      : runState === 'failed' || runState === 'timed_out'
        ? 'bg-rose-500'
        : runState === 'succeeded'
          ? 'bg-emerald-500'
          : isActiveRun(runState)
            ? 'bg-accent'
            : 'bg-slate-400';
  if (!projection?.run && stream.state === 'live') return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span className="flex items-center gap-2">
        <span className={'size-1.5 rounded-full ' + indicator} />
        {stream.state === 'live' ? '' : connections[stream.state]}
      </span>
      {projection?.run && (
        <span role="status" className="font-medium">
          {cancelling && isActiveRun(projection.run.state)
            ? '正在请求停止，等待设备确认'
            : projection.run.reason === 'RUNNER_OFFLINE'
              ? '设备离线，运行已暂停'
              : (states[projection.run.state] ?? projection.run.state)}
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
