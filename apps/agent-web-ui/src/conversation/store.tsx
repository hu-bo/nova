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
  // 本页发起的会话已经拥有完整的本地消息；导航不需要再用历史快照重建它。
  const needsHistory = useMemo(
    () => enabled && conversationStore.state(conversationId).messages.length === 0,
    [conversationId, enabled],
  );
  const history = useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: () => api!.listMessages(conversationId),
    enabled: Boolean(api) && needsHistory,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const run = useQuery({
    queryKey: ["conversation-run", conversationId],
    queryFn: () => api!.getConversationRun(conversationId),
    enabled: Boolean(api) && enabled,
    refetchInterval: 3000,
    refetchOnWindowFocus: true,
    retry: 1,
  });
  useEffect(() => {
    const snapshot = run.data;
    if (!snapshot) return;
    dispatch({ type: "event", event: { type: "run.state", state: snapshot }, conversationId });
    if (snapshot.status !== "running") {
      let disposed = false;
      void api!
        .listMessages(conversationId)
        .then((page) => {
          if (!disposed) dispatch({ type: "hydrate", messages: page.items, runVersion: snapshot.version });
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
      };
    }
  }, [run.data, api, conversationId, dispatch]);

  const context = useQuery({
    queryKey: queryKeys.context(conversationId),
    queryFn: () => api!.getConversationContext(conversationId),
    enabled: Boolean(api) && enabled,
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    if (needsHistory && history.data)
      dispatch({ type: "hydrate", messages: history.data.items, preserveLiveState: true });
  }, [dispatch, history.data, needsHistory]);
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
    retryHistory: async () => {
      const result = await history.refetch();
      if (result.data && !result.error)
        dispatch({ type: "hydrate", messages: result.data.items, preserveLiveState: true });
    },
    ensureStreamConnected: stream.ensureConnected,
    releaseStream: stream.release,
    resume: async () => {
      await api!.resumeConversation(conversationId);
      await run.refetch();
    },
    refreshRun: () => {
      void run.refetch();
    },
  };
}
