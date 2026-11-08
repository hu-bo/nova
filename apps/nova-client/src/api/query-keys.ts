/**
 * Query key factory with identity scope.
 *
 * 与 docs/nova-client.md §6.2 对齐: 所有 cache key 必须以 `['nova', identityId, ...]` 开头,
 * 切换身份时由 clearAll() 把 cache 清空; 不能跨身份复用 query key. 后续 team 功能接入
 * space 时, 在 identity 与 resource 之间追加 activeSpaceId 一段.
 */
export const queryKeys = {
  root: () => ['nova'] as const,
  forIdentity: (identityId: string) => ['nova', identityId] as const,
  projects: {
    root: (identityId: string) => ['nova', identityId, 'projects'] as const,
    list: (identityId: string, filters: { limit?: number; search?: string } = {}) =>
      ['nova', identityId, 'projects', 'list', filters] as const,
    detail: (identityId: string, id: string) =>
      ['nova', identityId, 'projects', 'detail', id] as const,
    binding: (identityId: string, id: string) =>
      ['nova', identityId, 'projects', 'binding', id] as const,
  },
  specs: {
    root: (identityId: string) => ['nova', identityId, 'specs'] as const,
    list: (identityId: string, projectId: string) => ['nova', identityId, 'specs', 'list', projectId] as const,
    detailRoot: (identityId: string, specId: string) => ['nova', identityId, 'specs', 'detail', specId] as const,
    detail: (identityId: string, specId: string, revision?: number) =>
      ['nova', identityId, 'specs', 'detail', specId, revision ?? 'current'] as const,
    attempts: (identityId: string, specId: string, revision: number, taskKey?: string) =>
      ['nova', identityId, 'specs', 'attempts', specId, revision, taskKey ?? 'all'] as const,
  },
  conversations: {
    history: (identityId: string, id: string, includeToolResults = true) =>
      [
        'nova',
        identityId,
        'conversations',
        'history',
        id,
        ...(includeToolResults ? [] : ['without-tool-results']),
      ] as const,
    root: (identityId: string) => ['nova', identityId, 'conversations'] as const,
    list: (identityId: string, filters: { limit?: number; mode?: 'chat' | 'project' } = {}) =>
      ['nova', identityId, 'conversations', 'list', filters] as const,
    detail: (identityId: string, id: string) =>
      ['nova', identityId, 'conversations', 'detail', id] as const,
    snapshot: (identityId: string, id: string, includeToolResults = true) =>
      [
        'nova',
        identityId,
        'conversations',
        'snapshot',
        id,
        ...(includeToolResults ? [] : ['without-tool-results']),
      ] as const,
  },
  runs: {
    root: (identityId: string) => ['nova', identityId, 'runs'] as const,
    detail: (identityId: string, runId: string) =>
      ['nova', identityId, 'runs', 'detail', runId] as const,
  },
  attachments: {
    upload: (identityId: string, key: string) =>
      ['nova', identityId, 'attachments', 'upload', key] as const,
  },
  runners: {
    root: (identityId: string) => ['nova', identityId, 'runners'] as const,
    list: (identityId: string) => ['nova', identityId, 'runners', 'list'] as const,
    tokens: (identityId: string) => ['nova', identityId, 'runners', 'tokens'] as const,
    files: (identityId: string, runnerId: string, path: string) =>
      ['nova', identityId, 'runners', 'files', runnerId, path] as const,
  },
};
