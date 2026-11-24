import { useSearch } from '@tanstack/react-router';
import { skillSelectionSchema } from '@nova/agent-ui-contracts';
import { DraftWorkspace } from './draft-workspace';

/**
 * 新建会话 —— 参考 `pages/project/new-conversation.tsx` + `pages/conversation.tsx` 草稿模式：
 * 直接进入与正式会话同布局的草稿对话页，首次发送时才创建会话并 replace 跳转到正式 URL。
 * 会话类型由左侧入口决定：普通会话进入无 search 参数的路径，项目会话带 projectId。
 * skill 参数由 /skills 页「在会话中使用」带入，只预选技能标签，发送后才执行（§3.1）。
 */
export function NewConversation() {
  const search = useSearch({ strict: false }) as {
    projectId?: string;
    mode?: 'spec' | 'career';
    skill?: { id: string; version: string };
  };
  const initialSkill = skillSelectionSchema.safeParse(search.skill);
  return (
    <DraftWorkspace
      key={(search.projectId ?? 'chat') + ':' + (search.mode ?? 'chat')}
      mode={search.projectId ? 'project' : 'chat'}
      projectId={search.projectId}
      initialSpecMode={search.mode === 'spec'}
      careerCoach={search.mode === 'career' && !search.projectId}
      {...(initialSkill.success ? { initialSkill: initialSkill.data } : {})}
    />
  );
}
