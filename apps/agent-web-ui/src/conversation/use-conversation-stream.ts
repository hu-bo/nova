import type { ChatMessage } from "@nova/protocol";
import { useCallback, useEffect, useMemo, useRef, type Dispatch } from "react";
import type { ConversationAction } from "./reducer.js";
import { ConversationStream } from "./conversation-stream.js";

interface UseConversationStreamOptions {
  conversationId: string;
  dispatch: Dispatch<ConversationAction>;
  loadSnapshot: () => Promise<ChatMessage[]>;
  onRunEnd: () => void;
}

export function useConversationStream({
  conversationId,
  dispatch,
  loadSnapshot,
  onRunEnd,
}: UseConversationStreamOptions) {
  const callbacks = useRef({ dispatch, loadSnapshot, onRunEnd });
  callbacks.current = { dispatch, loadSnapshot, onRunEnd };

  const stream = useMemo(
    () =>
      new ConversationStream(conversationId, {
        onConnection: (connection) => callbacks.current.dispatch({ type: "connection", connection }),
        onEvent: (event) => callbacks.current.dispatch({ type: "event", event, conversationId }),
        onOpen: () => callbacks.current.dispatch({ type: "clear-error" }),
        onResync: async () => {
          const messages = await callbacks.current.loadSnapshot();
          callbacks.current.dispatch({ type: "hydrate", messages });
        },
        onRunEnd: () => callbacks.current.onRunEnd(),
      }),
    [conversationId],
  );

  useEffect(() => () => stream.close(), [stream]);

  const ensureConnected = useCallback(() => stream.ensureConnected(), [stream]);
  return { ensureConnected };
}
