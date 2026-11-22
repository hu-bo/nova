import { resolveRemotePath } from '@/features/remotes';
import { Target } from 'lucide-react';
import { EXECUTION_MODES } from './execution-modes';
import { type ConversationComposerController } from './use-conversation-composer';
import { Input } from '@/components/ui/input';

export function ConversationContext({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  const model = ctl.modelProfiles.find((profile) => profile.id === ctl.modelProfileId);
  let workEnvironment = '普通 Chat';
  if (ctl.selectedRemote) workEnvironment = ctl.selectedRemote.name + ' · SSH';
  else if (ctl.binding?.runnerId) workEnvironment = '项目 Runner';
  let executionLabel = EXECUTION_MODES[ctl.executionMode].contextLabel;
  if (ctl.chatAgent) executionLabel = '文字对话 · 无外部工具';
  return (
    <section className="rounded-xl border border-slate-200 bg-slate-50/40 p-4">
      <h2 className="text-xs font-semibold text-slate-500">会话上下文</h2>
      <dl className="mt-4 space-y-4 text-xs">
        <div>
          <dt className="text-slate-500">模型</dt>
          <dd className="mt-1 break-all font-medium text-slate-700">
            {model?.model ?? '尚未选择模型'}
          </dd>
          {model && <dd className="mt-1 text-slate-500">{model.providerName}</dd>}
        </div>
        <div>
          <dt className="text-slate-500">模式</dt>
          <dd className="mt-1 font-medium text-slate-700">{executionLabel}</dd>
        </div>
        <div>
          <dt className="text-slate-500">工作环境</dt>
          <dd className="mt-1 break-all text-slate-700">{workEnvironment}</dd>
          {(ctl.binding || ctl.selectedRemote) && (
            <dd className="mt-1 break-all font-mono leading-5 text-slate-500">
              {ctl.selectedRemote
                ? resolveRemotePath(ctl.selectedRemote.rootPath, ctl.binding?.canonicalCwd)
                : ctl.binding?.canonicalCwd}
            </dd>
          )}
        </div>
      </dl>
      <fieldset className="mt-4 space-y-3 border-t border-slate-200 pt-4 text-xs">
        <legend className="font-medium text-slate-700">每轮执行预算</legend>
        <p className="text-slate-500">留空表示不限制；修改后从下一轮发送开始生效。</p>
        <label className="block space-y-1">
          <span>工作步数上限</span>
          <Input
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
        <label className="block space-y-1">
          <span>工具调用次数上限</span>
          <Input
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
      </fieldset>
      {ctl.goalArmed && (
        <div className="mt-4 border-t border-slate-200 pt-4">
          <p className="flex items-center gap-2 text-xs font-medium text-accent">
            <Target size={14} />
            目标已准备
          </p>
          <p className="mt-2 text-xs leading-5 text-slate-500">
            下一条消息成为目标，最多推进 {ctl.maxIterations} 轮。
          </p>
        </div>
      )}
    </section>
  );
}
