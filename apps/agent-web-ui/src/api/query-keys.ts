export const queryKeys = {
  projects: ["projects"] as const,
  project: (projectId: string) => ["projects", projectId] as const,
  conversationLists: ["conversation-lists"] as const,
  conversations: (projectId?: string) => ["conversation-lists", { projectId: projectId ?? null }] as const,
  messages: (conversationId: string) => ["conversations", conversationId, "messages"] as const,
  settings: ["settings"] as const,
  runners: ["runners"] as const,
  runnerDirectories: (runnerId: string, path?: string) => ["runners", runnerId, "directories", path ?? null] as const,
  runnerTokens: ["runner-tokens"] as const,
  runnerConnection: ["runner-connection"] as const,
};
