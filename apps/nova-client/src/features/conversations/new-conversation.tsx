import { useSearch } from '@tanstack/react-router';
import { DraftWorkspace } from './draft-workspace';

/**
 * 新建会话 —— 参考 `pages/project/new-conversation.tsx` + `pages/conversation.tsx` 草稿模式：
 * 直接进入与正式会话同布局的草稿对话页，首次发送时才创建会话并 replace 跳转到正式 URL。
 * 会话类型由左侧入口决定：普通会话进入无 search 参数的路径，项目会话带 projectId。
 */
export function NewConversation() {
  const search = useSearch({ strict: false }) as { projectId?: string };
  return (
    <DraftWorkspace
      key={search.projectId ?? 'chat'}
      mode={search.projectId ? 'project' : 'chat'}
      projectId={search.projectId}
    />
  );
}
