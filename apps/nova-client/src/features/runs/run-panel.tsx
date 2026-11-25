import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';
import type { Configuration } from '@nova/agent-ui-contracts';
import type { RunControls } from './run-controls';
import type { RunStreamSnapshot } from './run-stream-manager';

/**
 * 运行事件面板。运行状态行已移至会话标题栏的 `RunStatus` 指示（任务详情开关左侧）；
 * 决策裁决 UI 已移入 `Chat` 的决策浮层（与参考实现一致）；
 * 工具参数与输出由 `Chat` 的消息内工具块渲染，不再在此重复展示；
 * 运行失败报错（含提供商原文）由服务端写入失败消息的错误块，在消息内展示。
 * 这里只保留流错误与预算耗尽提示。
 * TODO 计划由 `Chat` 的侧栏 / 折叠面板渲染，不再在此重复。
 * 开发期诊断不在这里：连接 / 协议 / 快照对齐异常由 `run-stream-manager` 输出到浏览器控制台。
 */
export function RunPanel({
  stream,
  controls,
  executionEnabled = true,
  continuationConfiguration,
  budgetValid = true,
}: {
  stream: RunStreamSnapshot;
  controls: RunControls;
  executionEnabled?: boolean;
  continuationConfiguration?: Configuration;
  budgetValid?: boolean;
}) {
  const projection = stream.projection;
  const { cancel } = controls;
  const runState = projection?.run?.state;
  return (
    <div className="space-y-2 px-4 py-2 sm:px-6">
      {stream.error && (
        <p role="status" className="text-xs text-muted-foreground">
          {stream.error}
        </p>
      )}
      {runState === 'budget_exhausted' && (
        <div
          className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm"
          role="status"
        >
          <strong>预算耗尽，任务未完成</strong>
          <p className="mt-1">已保存当前进度。继续后将开启新一轮，并重新计算本轮预算。</p>
          <Button
            className="mt-2"
            variant="outline"
            disabled={
              !executionEnabled ||
              !budgetValid ||
              controls.continueRun.isPending ||
              controls.continueRun.isSuccess ||
              Boolean(projection?.startingInput)
            }
            onPress={() => controls.continueRun.mutate(continuationConfiguration)}
          >
            {controls.continueRun.isPending || controls.continueRun.isSuccess
              ? '正在继续…'
              : '继续任务'}
          </Button>
          {controls.continueRun.error && <ErrorNotice error={controls.continueRun.error} />}
        </div>
      )}
      {cancel.error && <ErrorNotice error={cancel.error} />}
    </div>
  );
}
