import { Button } from '@/components/ui/button';
import { Target } from 'lucide-react';
import type { ConversationComposerController } from './use-conversation-composer';

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
        aria-label={
          hasGoal ? '查看当前目标' : ctl.goalArmed ? '取消目标模式' : '将下一条消息作为目标'
        }
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
