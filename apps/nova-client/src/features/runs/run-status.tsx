import { Button } from '@/components/ui/button';
import { runPresentation } from './run-presentation';
import { isActiveRun } from './run-event-reducer';
import type { RunControls } from './run-controls';
import type { RunStreamSnapshot } from './run-stream-manager';
const connections = {
  connecting: '正在连接',
  live: '实时连接',
  reconnecting: '正在重连',
  offline: '连接已断开',
} satisfies Record<RunStreamSnapshot['state'], string>;

/**
 * 会话标题栏的运行状态指示（与参考实现一致，放在任务详情开关左侧）。
 * 从 `RunPanel` 的状态行抽出：连接状态点、运行状态文字与重连倒计时，
 * 让正文区不再为状态单独占一行；停止操作的入口在输入框的停止按钮与暂停横幅。
 */
export function RunStatus({
  stream,
  controls,
  onRetry,
}: {
  stream: RunStreamSnapshot;
  controls: RunControls;
  onRetry: () => void;
}) {
  const projection = stream.projection;
  const { cancelling, now } = controls;
  const run = projection?.run;
  const awaitingStart =
    projection?.startingInput?.state === 'queued' &&
    !projection.startingInput.runId &&
    !isActiveRun(run?.state);
  let presentation = run ? runPresentation[run.state] : null;
  if (awaitingStart) presentation = runPresentation.queued;
  const indicator =
    stream.state === 'live' ? (presentation?.indicator ?? 'bg-slate-400') : 'bg-amber-500';
  let statusLabel = presentation?.label ?? '';
  if (run && !awaitingStart) {
    if (cancelling && isActiveRun(run.state)) {
      statusLabel = '正在请求停止，等待设备确认';
    } else if (run.reason === 'RUNNER_OFFLINE') {
      statusLabel = '设备离线，运行已暂停';
    }
  }
  if (!presentation && stream.state === 'live') return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-3 gap-y-1">
      <span className="flex items-center gap-2">
        <span className={'size-1.5 rounded-full ' + indicator} />
        {stream.state === 'live' ? '' : connections[stream.state]}
      </span>
      {presentation && (
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
    </div>
  );
}
