import type { Block, ChatMessage, ContextUsage, SendMessage, Todo, UiEvent } from "@nova/protocol";

export interface QueuedMessage {
  message: ChatMessage;
  request: SendMessage;
}

export interface ConversationState {
  messages: ChatMessage[];
  queuedMessages: QueuedMessage[];
  todos: Todo[];
  contextUsage: ContextUsage | null;
  contextCompaction: Extract<UiEvent, { type: "context.compacted" }> | null;
  pendingDecision: Extract<UiEvent, { type: "decision.requested" }>["request"] | null;
  connection: "connecting" | "open" | "reconnecting" | "closed";
  isRunning: boolean;
  queueReady: boolean;
  error: string | null;
}

export type ConversationAction =
  | { type: "hydrate"; messages: ChatMessage[] }
  | { type: "connection"; connection: ConversationState["connection"] }
  | { type: "context.set"; usage: ContextUsage }
  | { type: "event"; event: UiEvent; conversationId: string }
  | { type: "optimistic.add"; message: ChatMessage }
  | { type: "optimistic.queue"; queued: QueuedMessage }
  | { type: "optimistic.fail"; messageId: string; keepRunning: boolean; message: string }
  | { type: "optimistic.retry"; messageId: string }
  | { type: "queue.start"; messageId: string }
  | { type: "queue.remove"; messageId: string }
  | { type: "clear-error" }
  | { type: "clear-context-compaction" };

export const initialConversationState: ConversationState = {
  messages: [],
  queuedMessages: [],
  todos: [],
  contextUsage: null,
  contextCompaction: null,
  pendingDecision: null,
  connection: "closed",
  isRunning: false,
  queueReady: false,
  error: null,
};

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "hydrate": {
      const messages = mergeHydratedMessages(action.messages, state.messages);
      return {
        ...state,
        messages,
        todos: latestTodos(messages),
        pendingDecision: null,
        isRunning: messages.some((message) => message.status === "streaming"),
        queueReady: false,
        error: null,
      };
    }
    case "connection":
      return { ...state, connection: action.connection };
    case "context.set":
      return { ...state, contextUsage: action.usage };
    case "optimistic.add":
      return state.messages.some((message) => message.id === action.message.id)
        ? state
        : { ...state, messages: [...state.messages, action.message], isRunning: true, queueReady: false, error: null };
    case "optimistic.queue":
      return state.queuedMessages.some((queued) => queued.message.id === action.queued.message.id)
        ? state
        : { ...state, queuedMessages: [...state.queuedMessages, action.queued], error: null };
    case "optimistic.fail":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (message) => ({ ...message, status: "error" })),
        queuedMessages: state.queuedMessages.filter((queued) => queued.message.id !== action.messageId),
        isRunning: action.keepRunning,
        queueReady: false,
        error: action.message,
      };
    case "optimistic.retry":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (message) => ({ ...message, status: "done" })),
        isRunning: true,
        queueReady: false,
        error: null,
      };
    case "queue.start": {
      const queued = state.queuedMessages.find((item) => item.message.id === action.messageId);
      if (!queued) return state;
      return {
        ...state,
        messages: [...state.messages, queued.message],
        queuedMessages: state.queuedMessages.filter((item) => item.message.id !== action.messageId),
        isRunning: true,
        queueReady: false,
        error: null,
      };
    }
    case "queue.remove":
      return {
        ...state,
        queuedMessages: state.queuedMessages.filter((item) => item.message.id !== action.messageId),
      };
    case "clear-error":
      return { ...state, error: null };
    case "clear-context-compaction":
      return { ...state, contextCompaction: null };
    case "event":
      return reduceEvent(state, action.event, action.conversationId);
  }
}

function mergeHydratedMessages(snapshot: ChatMessage[], current: ChatMessage[]): ChatMessage[] {
  const currentById = new Map(current.map((message) => [message.id, message]));
  const hydrated = snapshot.map((message) => {
    const existing = currentById.get(message.id);
    return existing?.status === "streaming" ? existing : message;
  });
  const hydratedIds = new Set(snapshot.map((message) => message.id));
  return [...hydrated, ...current.filter((message) => !hydratedIds.has(message.id))];
}

function reduceEvent(state: ConversationState, event: UiEvent, conversationId: string): ConversationState {
  switch (event.type) {
    case "message.start": {
      if (state.messages.some((message) => message.id === event.messageId)) {
        return { ...state, isRunning: true, queueReady: false, error: null };
      }
      const message: ChatMessage = {
        id: event.messageId,
        conversationId,
        role: event.role,
        blocks: [],
        status: "streaming",
        createdAt: Date.now(),
      };
      return { ...state, messages: [...state.messages, message], isRunning: true, queueReady: false, error: null };
    }
    case "block.start":
      return { ...state, messages: setBlock(state.messages, event.messageId, event.index, event.block) };
    case "block.delta":
      return { ...state, messages: appendBlockDelta(state.messages, event.messageId, event.index, event.delta) };
    case "block.end":
      return { ...state, messages: setBlock(state.messages, event.messageId, event.index, event.block) };
    case "message.end":
      return {
        ...state,
        messages: updateMessage(state.messages, event.messageId, (message) => ({ ...message, status: event.status })),
      };
    case "tool.output":
      return { ...state, messages: appendToolOutput(state.messages, event.callId, event.stream, event.text) };
    case "decision.requested":
      return { ...state, pendingDecision: event.request };
    case "decision.resolved":
      return state.pendingDecision?.decisionId === event.decisionId ? { ...state, pendingDecision: null } : state;
    case "todo.updated":
      return { ...state, todos: event.items };
    case "context.updated":
      return {
        ...state,
        contextUsage: {
          estimatedInputTokens: event.estimatedInputTokens,
          lastMeasuredInputTokens: event.lastMeasuredInputTokens,
          contextWindow: event.contextWindow,
          maxInputTokens: event.maxInputTokens,
          confidence: event.confidence,
        },
      };
    case "context.compacted":
      return { ...state, contextCompaction: event };
    case "run.end":
      return {
        ...state,
        isRunning: false,
        queueReady: event.stopReason !== "aborted" && event.stopReason !== "error",
      };
    case "error":
      return event.code === "RESYNC" ? state : { ...state, error: event.message };
  }
}

function updateMessage(
  messages: ChatMessage[],
  messageId: string,
  update: (message: ChatMessage) => ChatMessage,
): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.id !== messageId) return message;
    changed = true;
    return update(message);
  });
  return changed ? next : messages;
}

function setBlock(messages: ChatMessage[], messageId: string, index: number, block: Block): ChatMessage[] {
  return updateMessage(messages, messageId, (message) => {
    const blocks = [...message.blocks];
    while (blocks.length < index) blocks.push({ type: "text", text: "" });
    blocks[index] = block;
    return { ...message, blocks };
  });
}

function appendBlockDelta(messages: ChatMessage[], messageId: string, index: number, delta: string): ChatMessage[] {
  return updateMessage(messages, messageId, (message) => {
    const current = message.blocks[index];
    if (!current || (current.type !== "text" && current.type !== "thinking" && current.type !== "code")) return message;
    const blocks = [...message.blocks];
    blocks[index] =
      current.type === "code" ? { ...current, code: current.code + delta } : { ...current, text: current.text + delta };
    return { ...message, blocks };
  });
}

function appendToolOutput(
  messages: ChatMessage[],
  callId: string,
  stream: "stdout" | "stderr",
  text: string,
): ChatMessage[] {
  return messages.map((message) => {
    const callIndex = message.blocks.findIndex((block) => block.type === "tool_call" && block.callId === callId);
    if (callIndex < 0) return message;
    const blocks = [...message.blocks];
    const resultIndex = blocks.findIndex((block) => block.type === "tool_result" && block.callId === callId);
    const prefix = stream === "stderr" ? "[stderr] " : "";
    if (resultIndex >= 0) {
      const result = blocks[resultIndex];
      if (result?.type !== "tool_result") return message;
      const first = result.blocks[0];
      const outputBlocks: Block[] =
        first?.type === "code"
          ? [{ ...first, code: first.code + prefix + text }, ...result.blocks.slice(1)]
          : [{ type: "code", language: "text", code: prefix + text }, ...result.blocks];
      blocks[resultIndex] = { ...result, blocks: outputBlocks };
    } else {
      blocks.splice(callIndex + 1, 0, {
        type: "tool_result",
        callId,
        status: "ok",
        blocks: [{ type: "code", language: "text", code: prefix + text }],
      });
    }
    return { ...message, blocks };
  });
}

function latestTodos(messages: ChatMessage[]): Todo[] {
  let latest: Todo[] = [];
  const visit = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === "todo") latest = block.items;
      if (block.type === "tool_result") visit(block.blocks);
    }
  };
  for (const message of messages) visit(message.blocks);
  return latest;
}
