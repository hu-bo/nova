import { useNavigate } from "react-router-dom";

export interface NewConversationProject {
  id: string;
}

export function newConversationPath(project?: NewConversationProject) {
  return project ? `/p/${project.id}/c/new` : "/c/new";
}

export function draftConversationStateId(projectId: string | undefined, navigationKey: string) {
  return `draft:${projectId ?? "chat"}:${navigationKey}`;
}

export function useOpenNewConversation() {
  const navigate = useNavigate();
  return (project?: NewConversationProject) => navigate(newConversationPath(project));
}
