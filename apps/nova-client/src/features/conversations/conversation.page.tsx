import { useParams } from '@tanstack/react-router';
import { lazy } from 'react';
import { NewConversation } from './new-conversation';

// 新建会话无需加载历史消息渲染、导出和管理界面。
const ConversationView = lazy(() =>
  import('./conversation-view').then((module) => ({ default: module.ConversationView })),
);

export function ConversationPage() {
  const { id } = useParams({ strict: false }) as { id?: string };
  return id ? <ConversationView key={id} id={id} /> : <NewConversation />;
}
export { ConversationContext } from './conversation-context';
export { ConversationDetailsToggle } from './conversation-details-toggle';
export { RunnerBadge } from './runner-badge';
export { UnboundDialog } from './unbound-dialog';
