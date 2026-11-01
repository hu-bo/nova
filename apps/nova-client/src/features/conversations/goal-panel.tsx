import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Pause, Play, Target, Trash2 } from 'lucide-react';
import { updateConversationGoal } from '@/api/generated/conversations';
import type { GetConversationSnapshot200Goal } from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/error-notice';

export function GoalPanel({
  conversationId,
  goal,
  running = false,
}: {
  conversationId: string;
  goal: NonNullable<GetConversationSnapshot200Goal>;
  running?: boolean;
}) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const update = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'complete' | 'remove') =>
      updateConversationGoal(conversationId, { action, expectedRevision: goal.revision }),
    onSettled: () =>
      client.invalidateQueries({ queryKey: queryKeys.conversations.root(identity!.identityId) }),
  });
  const status = { ready: '准备推进', active: '正在推进', paused: '已暂停', completed: '已完成' }[
    goal.status
  ];
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" aria-label="当前目标">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Target size={15} />
          当前目标
        </h2>
        <span
          className={'text-xs ' + (goal.status === 'completed' ? 'text-success' : 'text-slate-400')}
        >
          {status}
        </span>
      </div>
      <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
        {goal.objective}
      </p>
      {goal.acceptanceCriteria && (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer">完成标准</summary>
          <p className="mt-2 whitespace-pre-wrap leading-5">{goal.acceptanceCriteria}</p>
        </details>
      )}
      <p className="mt-3 text-xs text-slate-400">
        执行轮次 {goal.iterations ?? 0} / {goal.maxIterations ?? 10}
      </p>
      {goal.status === 'paused' && (goal.iterations ?? 0) >= (goal.maxIterations ?? 10) && (
        <p className="mt-2 text-xs leading-5 text-slate-400">
          已达到轮次上限。可以标记完成，或移除目标后设置新的目标。
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-1">
        {goal.status === 'paused' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={
              update.isPending || running || (goal.iterations ?? 0) >= (goal.maxIterations ?? 10)
            }
            onPress={() => update.mutate('resume')}
          >
            <Play size={13} />
            继续
          </Button>
        ) : (
          goal.status !== 'completed' && (
            <Button
              variant="ghost"
              size="sm"
              disabled={update.isPending}
              onPress={() => update.mutate('pause')}
            >
              <Pause size={13} />
              暂停
            </Button>
          )
        )}
        {goal.status !== 'completed' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={update.isPending || running}
            onPress={() => update.mutate('complete')}
          >
            <Check size={13} />
            标记完成
          </Button>
        )}
        <Button
          variant="ghost"
          isIconOnly
          aria-label="移除当前目标"
          disabled={update.isPending || running}
          onPress={() => update.mutate('remove')}
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {update.error && (
        <div className="mt-2">
          <ErrorNotice error={update.error} />
        </div>
      )}
    </section>
  );
}
