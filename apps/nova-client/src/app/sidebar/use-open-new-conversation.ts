import { useNavigate } from '@tanstack/react-router';
import type { SidebarNewConversation, SidebarNewConversationProject } from './sidebar.types';

/**
 * 源参考 `pages/project/new-conversation.tsx` 中 `useOpenNewConversation` 的适配版。
 *
 * - 无参：跳到 `/conversations`（源参考中的 `/c/new`），由 `ConversationPage` 渲染 `NewConversation`。
 * - 带 project：跳到 `/conversations?projectId=X`（源参考中的 `/p/:id/c/new`），
 *   同样由 `NewConversation` 组件读取 `projectId` 搜索参数并预选该项目。
 */
export function useOpenNewConversation(): SidebarNewConversation {
  const navigate = useNavigate();
  return (project?: SidebarNewConversationProject) => {
    if (project) {
      void navigate({ to: '/conversations', search: { projectId: project.id } });
    } else {
      void navigate({ to: '/conversations' });
    }
  };
}
