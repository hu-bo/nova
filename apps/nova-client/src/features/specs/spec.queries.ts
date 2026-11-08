import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import type { Configuration } from '@nova/agent-ui-contracts';
import { createSpec, getSpec } from '@/api/generated/specs';
import { CommandIntent } from '@/api/command-intent';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';

export function useStartSpecMutation() {
  const { identity } = useIdentity();
  const client = useQueryClient();
  const intent = useRef(new CommandIntent());
  return useMutation({
    mutationFn: async (input: {
      projectId: string;
      message: string;
      configuration: Configuration;
    }) => {
      const body = {
        title: input.message.split(/\r?\n/)[0]?.trim().slice(0, 80) || '新规格',
        brief: input.message,
        startGeneration: true,
        configuration: {
          backendId: input.configuration.backendId,
          modelId: input.configuration.modelId,
          ...(input.configuration.reasoningEffort
            ? { reasoningEffort: input.configuration.reasoningEffort }
            : {}),
        },
      };
      const result = await createSpec(input.projectId, body, {
        headers: {
          'Idempotency-Key': intent.current.prepare({ projectId: input.projectId, ...body }),
        },
      });
      intent.current.accepted();
      return result;
    },
    onSuccess: async (_result, input) => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: queryKeys.specs.list(identity!.identityId, input.projectId),
        }),
        client.invalidateQueries({
          queryKey: queryKeys.conversations.list(identity!.identityId, { limit: 100 }),
        }),
      ]);
    },
  });
}

export function useSpecQuery(projectId: string, specId: string | null, revision?: number) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.specs.detail(identity?.identityId ?? 'anonymous', specId ?? '', revision),
    enabled: Boolean(identity && projectId && specId),
    queryFn: ({ signal }) =>
      getSpec(projectId, specId!, revision ? { revision } : undefined, { signal }),
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.tasks.some((task) =>
        ['queued', 'running', 'waiting', 'needs_reconciliation'].includes(task.status),
      )
        ? 3000
        : false,
  });
}
