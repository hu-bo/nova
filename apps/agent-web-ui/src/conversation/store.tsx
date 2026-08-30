import type { ChatMessage } from "@nova/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import {
  conversationReducer,
  initialConversationState,
  type ConversationAction,
  type ConversationState,
} from "./reducer.js";
import { useConversationStream } from "./use-conversation-stream.js";
interface ConversationStoreState {
  conversations: Record<string, ConversationState | undefined>;
  dispatch(conversationId: string, action: ConversationAction): void;
}

const useConversationStateStore = create<ConversationStoreState>((set) => ({
  conversations: {},
  dispatch: (conversationId, action) =>
    set((store) => {
      const state = store.conversations[conversationId] ?? initialConversationState;
      const next = conversationReducer(state, action);
      return next === state ? store : { conversations: { ...store.conversations, [conversationId]: next } };
    }),
}));

export function useConversationStore(conversationId: string) {
  const state = useConversationStateStore((store) => store.conversations[conversationId] ?? initialConversationState);
  const dispatchState = useConversationStateStore((store) => store.dispatch);
  const dispatch = useCallback(
    (action: ConversationAction) => dispatchState(conversationId, action),
    [conversationId, dispatchState],
  );
  return useMemo(() => ({ state, dispatch }), [dispatch, state]);
}

export const conversationStore = {
  dispatch(conversationId: string, action: ConversationAction) {
    useConversationStateStore.getState().dispatch(conversationId, action);
  },
  state(conversationId: string): ConversationState {
    return useConversationStateStore.getState().conversations[conversationId] ?? initialConversationState;
  },
};

export function useConversationSession(conversationId: string) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const { dispatch } = useConversationStore(conversationId);
  const history = useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: () => api!.listMessages(conversationId),
    enabled: Boolean(api),
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const context = useQuery({
    queryKey: queryKeys.context(conversationId),
    queryFn: () => api!.getConversationContext(conversationId),
    enabled: Boolean(api),
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    if (history.data) dispatch({ type: "hydrate", messages: history.data.items });
  }, [dispatch, history.data]);
  useEffect(() => {
    if (context.data) dispatch({ type: "context.set", usage: context.data });
  }, [context.data, dispatch]);

  const loadSnapshot = useCallback(async (): Promise<ChatMessage[]> => {
    const snapshot = await api!.listMessages(conversationId);
    queryClient.setQueryData(queryKeys.messages(conversationId), snapshot);
    return snapshot.items;
  }, [api, conversationId, queryClient]);
  const onRunEnd = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists, refetchType: "none" }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects, refetchType: "none" }),
    ]);
  }, [queryClient]);
  const stream = useConversationStream({ conversationId, loadSnapshot, onRunEnd });

  return {
    isLoading: history.isLoading,
    historyError: history.error,
    retryHistory: () => void history.refetch(),
    ensureStreamConnected: stream.ensureConnected,
  };
}
