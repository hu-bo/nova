import type { ChatMessage } from "@nova/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import {
  conversationReducer,
  initialConversationState,
  type ConversationAction,
  type ConversationState,
} from "./reducer.js";
import { useConversationStream } from "./use-conversation-stream.js";

interface ConversationContextValue {
  state: ConversationState;
  dispatch: Dispatch<ConversationAction>;
  isLoading: boolean;
  historyError: Error | null;
  retryHistory: () => void;
  ensureStreamConnected: () => Promise<void>;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(conversationReducer, initialConversationState);
  const history = useQuery({
    queryKey: queryKeys.messages(conversationId),
    queryFn: () => api!.listMessages(conversationId),
    enabled: Boolean(api),
    refetchOnWindowFocus: false,
    retry: 1,
  });

  useEffect(() => {
    if (history.data) dispatch({ type: "hydrate", messages: history.data.items });
  }, [history.data]);

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

  const stream = useConversationStream({
    conversationId,
    dispatch,
    loadSnapshot,
    onRunEnd,
  });

  const value = useMemo<ConversationContextValue>(
    () => ({
      state,
      dispatch,
      isLoading: history.isLoading,
      historyError: history.error,
      retryHistory: () => void history.refetch(),
      ensureStreamConnected: stream.ensureConnected,
    }),
    [state, history.isLoading, history.error, history.refetch, stream.ensureConnected],
  );
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversationStore() {
  const value = useContext(ConversationContext);
  if (!value) throw new Error("useConversationStore must be used within ConversationProvider");
  return value;
}
