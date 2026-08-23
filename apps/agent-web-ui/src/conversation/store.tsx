import type { ChatMessage } from "@nova/protocol";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type Dispatch, type ReactNode } from "react";
import { queryKeys } from "../api/query-keys.js";
import { useAuth } from "../auth/provider.js";
import { conversationReducer, initialConversationState, type ConversationAction, type ConversationState } from "./reducer.js";
import { useSse } from "./use-sse.js";

interface ConversationContextValue {
  state: ConversationState;
  dispatch: Dispatch<ConversationAction>;
  isLoading: boolean;
  historyError: Error | null;
  retryHistory: () => void;
}

const ConversationContext = createContext<ConversationContextValue | null>(null);

export function ConversationProvider({ conversationId, children }: { conversationId: string; children: ReactNode }) {
  const { api, logout } = useAuth();
  const queryClient = useQueryClient();
  const terminalRefreshPending = useRef(false);
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

  const onTerminal = useCallback(() => {
    if (terminalRefreshPending.current) return;
    terminalRefreshPending.current = true;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.messages(conversationId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.conversationLists }),
      queryClient.invalidateQueries({ queryKey: queryKeys.projects }),
    ]).finally(() => {
      terminalRefreshPending.current = false;
    });
  }, [conversationId, queryClient]);

  useSse({
    conversationId,
    accessToken: api?.accessToken ?? "",
    enabled: Boolean(api && history.isSuccess),
    dispatch,
    loadSnapshot,
    onTerminal,
    onUnauthorized: logout,
  });

  const value = useMemo<ConversationContextValue>(() => ({
    state,
    dispatch,
    isLoading: history.isLoading,
    historyError: history.error,
    retryHistory: () => void history.refetch(),
  }), [state, history.isLoading, history.error, history.refetch]);
  return <ConversationContext.Provider value={value}>{children}</ConversationContext.Provider>;
}

export function useConversationStore() {
  const value = useContext(ConversationContext);
  if (!value) throw new Error("useConversationStore must be used within ConversationProvider");
  return value;
}
