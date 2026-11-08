import { useRunnersQuery, type Runner } from '@/features/runners';
import { useRemoteConnectionsQuery, type RemoteConnection } from '@/features/remotes';

export type ProjectEnvironment = { target: string; canonicalCwd: string };

/** 环境绑定请求体的单一来源：Runner 已绑工作区优先，其次已验证的 SSH 连接。 */
function buildEnvironmentRequest(
  runner: Runner | undefined,
  remote: RemoteConnection | undefined,
  canonicalCwd: string,
) {
  if (runner?.workspaceId)
    return { runnerId: runner.id, workspaceId: runner.workspaceId, canonicalCwd };
  if (remote?.status === 'verified') return { remoteConnectionId: remote.id, canonicalCwd };
  return null;
}

export function useProjectEnvironmentRequest(value: ProjectEnvironment) {
  const runners = useRunnersQuery();
  const remotes = useRemoteConnectionsQuery();
  const runner = runners.data?.items.find((item) => value.target === 'runner:' + item.id);
  const remote = remotes.data?.items.find((item) => value.target === 'ssh:' + item.id);
  const request = buildEnvironmentRequest(runner, remote, value.canonicalCwd);
  return { request, runner, remote, runners, remotes };
}

export function validWorkspacePath(value: string, target = '') {
  const path = value.replace(/\\/g, '/');
  return (
    value.trim().length > 0 &&
    value.length <= 1024 &&
    ![...path].some((character) => character.charCodeAt(0) < 32) &&
    !/^[a-z]:/i.test(path) &&
    !path.split('/').includes('..') &&
    (target.startsWith('ssh:') || (!path.startsWith('/') && !path.split('/').includes('')))
  );
}
