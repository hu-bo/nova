/**
 * 与源参考 `apps/agent-web-ui/src/pages/app-shell.tsx` 中 `SidebarContent` 的 props
 * 形态对齐的最小组件契约。值字段尽量宽松（runnerState 允许字符串），方便上层
 * 把 `useProjectsQuery` 的 DTO 加上派生状态后直接传入。
 */

export type SidebarProject = {
  id: string;
  name: string;
  workspace?: string | null;
  runnerId?: string | null;
  runnerState: string;
};

export type SidebarConversation = {
  id: string;
  title: string | null;
  projectId: string | null;
  activeRunId?: string | null;
};

export type SidebarIdentity = {
  displayName: string | null;
  userId: string | null;
};

export type SidebarNewConversationProject = {
  id: string;
};

export type SidebarNewConversation = (project?: SidebarNewConversationProject) => void;
