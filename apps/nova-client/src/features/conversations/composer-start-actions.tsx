import { Button } from '@/components/ui/button';
import { Target } from 'lucide-react';
import type { ConversationComposerController } from './use-conversation-composer';

/** 目标按钮的无障碍文案：已有目标优先引导查看，其次描述本次点击的效果。 */
function goalActionLabel(hasGoal: boolean, goalArmed: boolean): string {
  if (hasGoal) return '查看当前目标';
  if (goalArmed) return '取消目标模式';
  return '将下一条消息作为目标';
}

export function ComposerStartActions({
  controller: ctl,
}: {
  controller: ConversationComposerController;
}) {
  const hasGoal = Boolean(ctl.goal && ctl.goal.status !== 'completed');
  if (ctl.specSession || ctl.specArmed) return null;
  return (
    <>
      <Button
        variant={ctl.goalArmed || hasGoal ? 'secondary' : 'ghost'}
        isIconOnly
        aria-label={goalActionLabel(hasGoal, ctl.goalArmed)}
        title="/goal · 设置会话目标"
        aria-pressed={ctl.goalArmed || hasGoal}
        disabled={ctl.sending}
        onPress={() => (hasGoal ? ctl.setGoalDialogOpen(true) : ctl.setGoalArmed(!ctl.goalArmed))}
      >
        <Target size={16} />
      </Button>
    </>
  );
}
