import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createRunnerToken,
  listRunners,
  listRunnerFiles,
  listRunnerTokens,
  revokeRunnerToken,
  rotateRunnerToken,
} from '@/api/generated/runners';
import type {
  ListRunners200ItemsItem,
  ListRunnerTokens200ItemsItem,
  CreateRunnerToken200,
  CreateRunnerTokenBody,
  ListRunnerFiles200,
} from '@/api/generated/projectsAPI.schemas';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
export type Runner = ListRunners200ItemsItem;
export type RunnerToken = ListRunnerTokens200ItemsItem;
export type RunnerTokenWithSecret = CreateRunnerToken200;
export type RemoteListing = ListRunnerFiles200;
export function runnerStatus(runner: Runner, now = Date.now()): 'online' | 'offline' | 'revoked' {
  return runner.revokedAt
    ? 'revoked'
    : runner.lastSeenAt && now - Date.parse(runner.lastSeenAt) < 60000
      ? 'online'
      : 'offline';
}
export function useRunnerTokensQuery() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.runners.tokens(identity?.identityId ?? 'anonymous'),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listRunnerTokens({ signal }),
  });
}
export function useCreateRunnerTokenMutation() {
  const client = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (input: CreateRunnerTokenBody) => createRunnerToken(input),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.runners.tokens(identity!.identityId) });
    },
  });
}
export function useRevokeRunnerTokenMutation() {
  const client = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (id: string) => revokeRunnerToken(id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.runners.tokens(identity!.identityId) });
    },
  });
}
export function useRotateRunnerTokenMutation() {
  const client = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (id: string) => rotateRunnerToken(id, { revokePrevious: true }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: queryKeys.runners.tokens(identity!.identityId) });
    },
  });
}
export function useRunnersQuery() {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.runners.list(identity?.identityId ?? 'anonymous'),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listRunners({ signal }),
    staleTime: 10000,
    refetchInterval: 30000,
    refetchIntervalInBackground: false,
  });
}
export function loadRunnerDirectory(runnerId: string, path = '.', signal?: AbortSignal) {
  return listRunnerFiles(runnerId, { path: path || '.' }, { ...(signal ? { signal } : {}) });
}
