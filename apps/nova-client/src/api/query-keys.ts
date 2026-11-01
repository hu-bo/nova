/**
 * Query key factory with identity scope.
 *
 * 与 docs/nova-client.md §6.2 对齐: 所有 cache key 必须以 `['nova', identityId, ...]` 开头,
 * 切换身份时由 clearAll() 把 cache 清空; 不能跨身份复用 query key. 后续 team 功能接入
 * space 时, 在 identity 与 resource 之间追加 activeSpaceId 一段.
 */
type Primitive = string | number | boolean | null | undefined;
type KeyPart = Primitive | readonly KeyPart[];

export const queryKeys = {
  root: () => ['nova'] as const,
  forIdentity: (identityId: string) => ['nova', identityId] as const,
  projects: {
    root: (identityId: string) => ['nova', identityId, 'projects'] as const,
    list: (identityId: string, filters: { limit?: number; search?: string } = {}) =>
      ['nova', identityId, 'projects', 'list', filters] as const,
    detail: (identityId: string, id: string) =>
      ['nova', identityId, 'projects', 'detail', id] as const,
  },
  conversations: {
    history: (identityId: string, id: string) =>
      ['nova', identityId, 'conversations', 'history', id] as const,
    root: (identityId: string) => ['nova', identityId, 'conversations'] as const,
    list: (identityId: string, filters: { limit?: number; mode?: 'chat' | 'project' } = {}) =>
      ['nova', identityId, 'conversations', 'list', filters] as const,
    detail: (identityId: string, id: string) =>
      ['nova', identityId, 'conversations', 'detail', id] as const,
    snapshot: (identityId: string, id: string) =>
      ['nova', identityId, 'conversations', 'snapshot', id] as const,
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

export type QueryKeyPart = KeyPart;

export function identityPrefix(identityId: string | null): readonly string[] {
  return identityId ? ['nova', identityId] : ['nova', 'anonymous'];
}
