import { lazy } from 'react';

export const ConversationPage = lazy(() =>
  import('./conversation.page').then((module) => ({ default: module.ConversationPage })),
);
export {
  useConversationsQuery,
  useConversationSnapshot,
  useCreateConversationMutation,
  useAppendPendingInputMutation,
  useRemovePendingInputMutation,
  useDeleteConversationMutation,
  type ConversationDTO,
  type ConversationSnapshot,
} from './conversation.queries';
