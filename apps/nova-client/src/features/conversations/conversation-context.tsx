import { resolveRemotePath } from '@/features/remotes';
import { Target } from 'lucide-react';
import { useId } from 'react';
import { EXECUTION_MODES } from './execution-modes';
import { type ConversationComposerController } from './use-conversation-composer';
import { Input } from '@/components/ui/input';

export function ConversationContext({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  const budgetHintId = useId();
  const model = ctl.modelProfiles.find((profile) => profile.id === ctl.modelProfileId);
  let workEnvironment = '普通 Chat';
  if (ctl.selectedRemote) workEnvironment = ctl.selectedRemote.name + ' · SSH';
  else if (ctl.binding?.runnerId) workEnvironment = '项目 Runner';
  const workingDirectory = ctl.selectedRemote
    ? resolveRemotePath(ctl.selectedRemote.rootPath, ctl.binding?.canonicalCwd)
    : ctl.binding?.canonicalCwd;
  let executionLabel = EXECUTION_MODES[ctl.executionMode].contextLabel;
  if (ctl.chatAgent) executionLabel = '文字对话 · 无外部工具';
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-3">
      <h2 className="text-xs font-semibold text-slate-700">会话上下文</h2>
      <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
        <dt className="whitespace-nowrap text-slate-500">模型</dt>
        <dd className="wrap-anywhere text-slate-700">
          <span className="font-medium">{model?.model ?? '尚未选择模型'}</span>
          {model?.providerName && (
            <>
              {' '}
              <span className="text-slate-500">·&nbsp;{model.providerName}</span>
            </>
          )}
        </dd>
        <dt className="whitespace-nowrap text-slate-500">模式</dt>
        <dd className="wrap-anywhere font-medium text-slate-700">{executionLabel}</dd>
        <dt className="whitespace-nowrap text-slate-500">工作环境</dt>
        <dd className="wrap-anywhere text-slate-700">
          {workEnvironment}
          {workingDirectory === '.' ? (
            <>
              {' '}
              <span className="text-slate-500">·&nbsp;根目录</span>
            </>
          ) : (
            workingDirectory && (
              <span className="block font-mono text-slate-500">{workingDirectory}</span>
            )
          )}
        </dd>
      </dl>
      <fieldset className="mt-3 min-w-0 text-xs" aria-describedby={budgetHintId}>
        <legend className="w-full border-t border-slate-200 pt-2.5 font-medium text-slate-700">
          每轮执行预算
        </legend>
        <div className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-slate-600">
          <label className="col-span-2 grid grid-cols-subgrid items-center whitespace-nowrap">
            <span>工作步数上限</span>
            <Input
              className="h-8 min-w-0 rounded-md px-2 text-xs tabular-nums"
              variant="secondary"
              type="number"
              min={1}
              step={1}
              placeholder="不限制"
              value={ctl.budgetLimits.maxSteps}
              onChange={(event) =>
                ctl.setBudgetLimits((limits) => ({ ...limits, maxSteps: event.target.value }))
              }
            />
          </label>
          <label className="col-span-2 grid grid-cols-subgrid items-center whitespace-nowrap">
            <span>工具调用次数上限</span>
            <Input
              className="h-8 min-w-0 rounded-md px-2 text-xs tabular-nums"
              variant="secondary"
              type="number"
              min={1}
              step={1}
              placeholder="不限制"
              value={ctl.budgetLimits.maxToolCalls}
              onChange={(event) =>
                ctl.setBudgetLimits((limits) => ({ ...limits, maxToolCalls: event.target.value }))
              }
            />
          </label>
        </div>
        <p id={budgetHintId} className="mt-2 text-slate-500">
          留空不限，下轮发送时生效。
        </p>
      </fieldset>
      {ctl.goalArmed && (
        <div className="mt-3 border-t border-slate-200 pt-2.5">
          <p className="flex items-center gap-2 text-xs font-medium text-accent">
            <Target size={14} />
            目标已准备
          </p>
          <p className="mt-1 text-xs text-slate-500">
            下一条消息成为目标，最多推进 {ctl.maxIterations} 轮。
          </p>
        </div>
      )}
    </section>
  );
}
