import { useQuery } from '@tanstack/react-query';
import { listRemoteConnections, listRemoteFiles } from '@/api/generated/remotes';
import type { ListRemoteConnections200ItemsItem } from '@/api/generated/projectsAPI.schemas';
import { useIdentity } from '@/features/auth';

export type RemoteConnection = ListRemoteConnections200ItemsItem;
export function useRemoteConnectionsQuery() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: ['nova', identity?.identityId ?? 'anonymous', 'remote-connections'],
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listRemoteConnections({ signal }),
    staleTime: 15000,
  });
}
export function loadRemoteDirectory(id: string, path = '/', signal?: AbortSignal) {
  return listRemoteFiles(id, { path }, { ...(signal ? { signal } : {}) });
}
export function resolveRemotePath(root: string, path = '.') {
  if (path.startsWith('/')) return path;
  const base = root.replace(/\/$/, '');
  return path === '.' ? base || '/' : base + '/' + path;
}
export function relativeRemotePath(root: string, path: string) {
  if (path === root) return '.';
  const prefix = root.replace(/\/$/, '') + '/';
  if (!path.startsWith(prefix)) return path;
  return path.slice(prefix.length);
}
