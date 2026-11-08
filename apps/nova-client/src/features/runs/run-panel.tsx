import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';
import type { RunControls } from './run-controls';
import type { RunStreamSnapshot } from './run-stream-manager';
const modelErrors: Record<string, string> = {
  MODEL_RATE_LIMITED: '模型服务限流或额度不足，请检查配额或切换模型。',
  MODEL_AUTH_FAILED: '模型服务认证失败，请检查模型的 API 密钥和访问权限。',
  MODEL_REQUEST_FAILED: '模型请求失败，请检查模型配置或稍后重试。',
};

/** 决策过期倒计时文案：无过期时间为空串，剩余 0 秒视为授权已过期。 */
function decisionCountdown(remaining: number | null): string {
  if (remaining === null) return '';
  if (remaining) return remaining + ' 秒后过期';
  return '授权已过期';
}

function VerificationNotice({ onRetry }: { onRetry: () => Promise<boolean> }) {
  const [refresh, setRefresh] = useState<'idle' | 'pending' | 'success' | 'error'>('idle');
  return (
    <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
      <strong>执行结果需要核实</strong>
      <p className="mt-1 leading-6">
        设备未确认执行结果。请展开消息中的工具记录查看输出和
        Diff，并到原工作区核实文件和相关进程的状态。
      </p>
      <p className="mt-1 leading-6">
        刷新会重新读取服务端已保存的记录。若消息中看不到工具记录，请检查「聊天设置」中的「显示工具调用」和「接收工具结果」。
      </p>
      <Button
        variant="outline"
        className="mt-2"
        disabled={refresh === 'pending'}
        onPress={async () => {
          setRefresh('pending');
          setRefresh((await onRetry()) ? 'success' : 'error');
        }}
      >
        {refresh === 'pending' ? '正在刷新核实材料…' : '刷新核实材料'}
      </Button>
      <p role="status" className="mt-1 text-muted-foreground">
        {refresh === 'success' && '已刷新会话记录，执行结果仍需人工核实。'}
        {refresh === 'error' && '未能刷新核实材料，请稍后重试。'}
      </p>
    </div>
  );
}

/**
 * 运行事件面板。运行状态行已移至会话标题栏的 `RunStatus` 指示（任务详情开关左侧）；
 * 决策裁决 UI 已移入 `Chat` 的决策浮层（与参考实现一致）；
 * 工具参数与输出由 `Chat` 的消息内工具块渲染，不再在此重复展示。
 * 这里只保留流错误、模型失败提示、核实面板与决策倒计时摘要。
 * TODO 计划由 `Chat` 的侧栏 / 折叠面板渲染，不再在此重复。
 * 开发期诊断不在这里：连接 / 协议 / 快照对齐异常由 `run-stream-manager` 输出到浏览器控制台。
 */
export function RunPanel({
  stream,
  controls,
  onRetry,
}: {
  stream: RunStreamSnapshot;
  controls: RunControls;
  onRetry: () => Promise<boolean>;
}) {
  const projection = stream.projection;
  const { cancel, decision, remaining } = controls;
  const runState = projection?.run?.state;
  const unknown =
    projection?.run?.state === 'cancelled_unconfirmed' ||
    Object.values(projection?.toolOutputs ?? {}).some((output) => output.status === 'unknown');
  return (
    <div className="space-y-2 px-4 py-2 sm:px-6">
      {stream.error && (
        <p role="status" className="text-xs text-muted-foreground">
          {stream.error}
        </p>
      )}
      {runState === 'failed' && projection?.run?.reason && modelErrors[projection.run.reason] && (
        <p role="alert" className="text-sm text-rose-600">
          {modelErrors[projection.run.reason]}
        </p>
      )}
      {unknown && <VerificationNotice key={projection?.run?.id} onRetry={onRetry} />}
      {cancel.error && <ErrorNotice error={cancel.error} />}
      {decision && (
        <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-amber-700">
          <span>等待你的确认</span>
          <span>{decisionCountdown(remaining)}</span>
        </p>
      )}
    </div>
  );
}
