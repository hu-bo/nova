import { ApiError } from '@/api/api-error';
import { queryKeys } from '@/api/query-keys';
import { ErrorNotice } from '@/components/error-notice';
import { useIdentity } from '@/features/auth';
import { useConversationStream } from '@/features/runs';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { ConversationWorkspace } from './conversation-workspace';
import { useConversationSnapshot } from './conversation.queries';

export function ConversationView({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const snapshot = useConversationSnapshot(id);
  const stream = useConversationStream(id, snapshot.data);
  useEffect(() => {
    if (snapshot.error instanceof ApiError && [403, 404].includes(snapshot.error.status)) {
      stream.forget();
      void client.invalidateQueries({
        queryKey: queryKeys.conversations.list(identity!.identityId, { limit: 100 }),
      });
    }
    // Resource disappearance should release its stream once, without requesting it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.error, client, identity, id]);
  if (snapshot.isPending)
    return (
      <div
        role="status"
        className="grid min-h-[60vh] place-items-center text-sm text-muted-foreground"
      >
        正在打开会话…
      </div>
    );
  if (snapshot.error)
    return (
      <div className="mx-auto max-w-xl space-y-4">
        <Link to="/conversations" className="text-sm text-accent">
          返回会话列表
        </Link>
        <ErrorNotice error={snapshot.error} onRetry={() => void snapshot.refetch()} />
      </div>
    );
  const conversation = snapshot.data.conversation;
  if (!embedded && conversation.specId && conversation.projectId)
    return <Navigate to="/specs/$id" params={{ id: conversation.specId }} search={{ projectId: conversation.projectId }} replace />;
  return <ConversationWorkspace id={id} data={snapshot.data} stream={stream} embedded={embedded} />;
}
