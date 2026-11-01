import { useRunnersQuery } from '@/features/runners';
import { useRemoteConnectionsQuery } from '@/features/remotes';

export type ProjectEnvironment = { target: string; canonicalCwd: string };
export function useProjectEnvironmentRequest(value: ProjectEnvironment) {
  const runners = useRunnersQuery();
  const remotes = useRemoteConnectionsQuery();
  const runner = runners.data?.items.find((item) => value.target === 'runner:' + item.id);
  const remote = remotes.data?.items.find((item) => value.target === 'ssh:' + item.id);
  const request = runner?.workspaceId
    ? { runnerId: runner.id, workspaceId: runner.workspaceId, canonicalCwd: value.canonicalCwd }
    : remote?.status === 'verified'
      ? { remoteConnectionId: remote.id, canonicalCwd: value.canonicalCwd }
      : null;
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
