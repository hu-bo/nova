import type { ChatMessage } from "@nova/protocol";
import { useCallback, useEffect, useRef } from "react";
import { ConversationStream } from "./conversation-stream.js";
import { conversationStore } from "./store.js";

interface UseConversationStreamOptions {
  conversationId: string;
  loadSnapshot: () => Promise<ChatMessage[]>;
  onRunEnd: () => void;
}

interface StreamEntry {
  stream: ConversationStream;
  mounted: number;
}

const streams = new Map<string, StreamEntry>();

function streamFor(conversationId: string, options: UseConversationStreamOptions): StreamEntry {
  const existing = streams.get(conversationId);
  if (existing) return existing;
  let entry!: StreamEntry;
  const stream = new ConversationStream(conversationId, {
    onConnection: (connection) => conversationStore.dispatch(conversationId, { type: "connection", connection }),
    onEvent: (event) => conversationStore.dispatch(conversationId, { type: "event", event, conversationId }),
    onOpen: () => conversationStore.dispatch(conversationId, { type: "clear-error" }),
    onResync: async () => {
      const messages = await options.loadSnapshot();
      conversationStore.dispatch(conversationId, { type: "hydrate", messages });
    },
    onRunEnd: () => {
      options.onRunEnd();
      if (entry.mounted) return;
      stream.close();
      streams.delete(conversationId);
    },
  });
  entry = { stream, mounted: 0 };
  streams.set(conversationId, entry);
  return entry;
}

export function useConversationStream(options: UseConversationStreamOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const entry = streamFor(options.conversationId, optionsRef.current);
    entry.mounted += 1;
    void entry.stream.ensureConnected().catch(() => undefined);
    return () => {
      entry.mounted -= 1;
      if (entry.mounted || conversationStore.state(options.conversationId).isRunning) return;
      entry.stream.close();
      streams.delete(options.conversationId);
    };
  }, [options.conversationId]);

  return {
    ensureConnected: useCallback(
      () => streamFor(options.conversationId, optionsRef.current).stream.ensureConnected(),
      [options.conversationId],
    ),
  };
}
