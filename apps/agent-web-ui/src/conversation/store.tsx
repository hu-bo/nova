import type { ChatMessage } from "@nova/protocol";
import type { MessageListScrollState } from "@nova/chat-ui";
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
  scrollStates: Record<string, MessageListScrollState | undefined>;
  setScrollState(conversationId: string, state: MessageListScrollState): void;
  dispatch(conversationId: string, action: ConversationAction): void;
  discard(conversationId: string): void;
}

const useConversationStateStore = create<ConversationStoreState>((set) => ({
  conversations: {},
  scrollStates: {},
  setScrollState: (conversationId, state) =>
    set((store) => ({ scrollStates: { ...store.scrollStates, [conversationId]: state } })),
  dispatch: (conversationId, action) =>
    set((store) => {
      const state = store.conversations[conversationId] ?? initialConversationState;
      const next = conversationReducer(state, action);
      return next === state ? store : { conversations: { ...store.conversations, [conversationId]: next } };
    }),
  discard: (conversationId) =>
    set((store) => {
      if (!Object.hasOwn(store.conversations, conversationId) && !Object.hasOwn(store.scrollStates, conversationId))
        return store;
      const conversations = { ...store.conversations };
      const scrollStates = { ...store.scrollStates };
      delete conversations[conversationId];
      delete scrollStates[conversationId];
      return { conversations, scrollStates };
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
  scrollState(conversationId: string): MessageListScrollState | undefined {
    return useConversationStateStore.getState().scrollStates[conversationId];
  },
  setScrollState(conversationId: string, state: MessageListScrollState) {
    useConversationStateStore.getState().setScrollState(conversationId, state);
  },
  dispatch(conversationId: string, action: ConversationAction) {
    useConversationStateStore.getState().dispatch(conversationId, action);
  },
  state(conversationId: string): ConversationState {
    return useConversationStateStore.getState().conversations[conversationId] ?? initialConversationState;
  },
  discard(conversationId: string) {
    useConversationStateStore.getState().discard(conversationId);
  },
};

export function useConversationSession(conversationId: string, enabled = true) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const { dispatch } = useConversationStore(conversationId);
  const history = useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: () => api!.listMessages(conversationId),
    enabled: Boolean(api) && enabled,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const context = useQuery({
    queryKey: queryKeys.context(conversationId),
    queryFn: () => api!.getConversationContext(conversationId),
    enabled: Boolean(api) && enabled,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    if (history.data) dispatch({ type: "hydrate", messages: history.data.items, preserveLiveState: true });
  }, [dispatch, history.data]);
  useEffect(() => {
    if (context.data) dispatch({ type: "context.set", usage: context.data });
  }, [context.data, dispatch]);

  const loadSnapshot = useCallback(
    async (targetConversationId: string): Promise<ChatMessage[]> => {
      const snapshot = await api!.listMessages(targetConversationId);
      queryClient.setQueryData(queryKeys.messages(targetConversationId), snapshot);
      return snapshot.items;
    },
    [api, queryClient],
  );
  const onRunEnd = useCallback(() => {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists, refetchType: "none" }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects, refetchType: "none" }),
    ]);
  }, [queryClient]);
  const stream = useConversationStream({ conversationId, loadSnapshot, onRunEnd, enabled });

  return {
    isLoading: enabled && history.isLoading,
    historyError: history.error,
    retryHistory: () => void history.refetch(),
    ensureStreamConnected: stream.ensureConnected,
    releaseStream: stream.release,
  };
}
