import type { Configuration, InputBlock, SubmitInput } from '@nova/agent-ui-contracts';
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  appendConversationInput,
  createConversation,
  deleteConversation,
  getConversationSnapshot,
  listConversations,
  removeConversationInput,
  steerConversationInput,
} from '@/api/generated/conversations';
import type {
  AppendConversationInputBody,
  CreateConversationBody,
  GetConversationSnapshot200,
  ListConversations200ItemsItem,
} from '@/api/generated/projectsAPI.schemas';
import { CommandIntent } from '@/api/command-intent';
import { queryKeys } from '@/api/query-keys';
import { useIdentity } from '@/features/auth';
import { usePreferences } from '@/features/settings';
export type ConversationDTO = ListConversations200ItemsItem;
export type ConversationSnapshot = GetConversationSnapshot200;
export type ConversationMode = ConversationDTO['mode'];
export type CreateConversationRequest = Omit<
  CreateConversationBody,
  'configuration' | 'initialInput'
> & { configuration?: Configuration; initialInput?: { blocks: InputBlock[] } };
export type PendingInputRequest = SubmitInput & Pick<AppendConversationInputBody, 'goal'>;
export function useConversationsQuery(input: { limit?: number; mode?: ConversationMode } = {}) {
  const { identity } = useIdentity();
  return useQuery({
    queryKey: queryKeys.conversations.list(identity?.identityId ?? 'anonymous', input),
    enabled: Boolean(identity),
    queryFn: ({ signal }) => listConversations({ limit: input.limit ?? 100 }, { signal }),
    refetchInterval: (query) =>
      query.state.data?.items.some((conversation) => conversation.activeRunId) ? 5000 : false,
    select: (data) => ({
      ...data,
      items: input.mode ? data.items.filter((item) => item.mode === input.mode) : data.items,
    }),
  });
}
export function useConversationSnapshot(conversationId: string | null) {
  const { identity } = useIdentity();
  const {
    preferences: { includeToolResults },
  } = usePreferences();
  return useQuery({
    queryKey: queryKeys.conversations.snapshot(
      identity?.identityId ?? 'anonymous',
      conversationId ?? '',
      includeToolResults,
    ),
    enabled: Boolean(identity && conversationId),
    queryFn: ({ signal }) =>
      getConversationSnapshot(
        conversationId!,
        { includeToolResults: includeToolResults ? 'true' : 'false' },
        { signal },
      ),
    staleTime: 10000,
  });
}
export function useCreateConversationMutation() {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  const intent = useRef(new CommandIntent());
  return useMutation({
    mutationFn: (request: CreateConversationRequest) =>
      createConversation(request as CreateConversationBody, {
        idempotencyKey: intent.current.prepare(request),
      }),
    onSuccess: async () => {
      intent.current.accepted();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.root(identity!.identityId),
      });
    },
  });
}
export function useAppendPendingInputMutation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  const intent = useRef(new CommandIntent());
  return useMutation({
    mutationFn: (request: PendingInputRequest) =>
      appendConversationInput(conversationId!, request as AppendConversationInputBody, {
        idempotencyKey: intent.current.prepare({ conversationId, ...request }),
      }),
    onSuccess: async () => {
      intent.current.accepted();
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.root(identity!.identityId),
      });
    },
    onError: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.snapshot(identity!.identityId, conversationId!),
      });
    },
  });
}
export function useRemovePendingInputMutation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (inputId: string) => removeConversationInput(conversationId!, inputId),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.snapshot(identity!.identityId, conversationId!),
      });
    },
  });
}

/**
 * 删除会话。对应源参考 `useConversationListMutations().remove`。
 * - mutationFn: 调用后端 `deleteConversation`
 * - onSuccess: 清空当前身份下的会话相关缓存（包括列表与快照）
 */
export function useDeleteConversationMutation() {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (id: string) => deleteConversation(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.root(identity!.identityId),
      });
    },
  });
}

export function useSteerPendingInputMutation(conversationId: string | null) {
  const queryClient = useQueryClient();
  const { identity } = useIdentity();
  return useMutation({
    mutationFn: (inputId: string) => steerConversationInput(conversationId!, inputId, {}),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversations.snapshot(identity!.identityId, conversationId!),
      }),
  });
}
