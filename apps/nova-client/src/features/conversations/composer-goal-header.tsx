import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Popover } from '@heroui/react';
import { ClipboardList, Settings2, Target, X } from 'lucide-react';
import type { ConversationComposerController } from './use-conversation-composer';

export function ComposerGoalHeader({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  if (!ctl.goalArmed)
    return ctl.executionMode === 'plan' ? (
      <p className="flex items-center gap-2 px-2 pb-2 pt-1 text-xs text-slate-500">
        <ClipboardList size={13} />
        Plan 模式 · 先分析和规划，不修改文件
      </p>
    ) : null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-accent-soft px-3 py-2 text-xs text-accent-soft-foreground">
      <Target size={14} />
      <span className="min-w-0 flex-1">下一条消息将作为会话目标</span>
      <Popover>
        <Button size="sm" variant="ghost" aria-label="目标选项">
          <Settings2 size={13} />
          <span>{ctl.maxIterations} 轮上限</span>
        </Button>
        <Popover.Content placement="top" className="z-50 w-72">
          <Popover.Dialog>
            <Popover.Heading>目标选项</Popover.Heading>
            <label className="mt-3 block text-sm">
              最多执行轮次
              <Input
                aria-label="目标执行轮次"
                className="mt-2"
                type="number"
                min="1"
                max="100"
                value={ctl.maxIterations}
                onChange={(event) =>
                  ctl.setMaxIterations(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
                }
              />
            </label>
            <label className="mt-3 block text-sm">
              完成标准
              <Textarea
                aria-label="目标完成标准"
                className="mt-2"
                rows={3}
                maxLength={8000}
                value={ctl.acceptanceCriteria}
                placeholder="可选：明确怎样算完成"
                onChange={(event) => ctl.setAcceptanceCriteria(event.target.value)}
              />
            </label>
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
      <Button
        variant="ghost"
        isIconOnly
        aria-label="取消目标模式"
        onPress={() => ctl.setGoalArmed(false)}
      >
        <X size={13} />
      </Button>
    </div>
  );
}
