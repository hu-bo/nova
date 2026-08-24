import type { Block, ChatMessage, Todo, UiEvent } from "@nova/protocol";

export interface ConversationState {
  messages: ChatMessage[];
  todos: Todo[];
  pendingDecision: Extract<UiEvent, { type: "decision.requested" }>["request"] | null;
  connection: "connecting" | "open" | "reconnecting" | "closed";
  isRunning: boolean;
  error: string | null;
}

export type ConversationAction =
  | { type: "hydrate"; messages: ChatMessage[] }
  | { type: "connection"; connection: ConversationState["connection"] }
  | { type: "event"; event: UiEvent; conversationId: string }
  | { type: "optimistic.add"; message: ChatMessage }
  | { type: "optimistic.fail"; messageId: string; keepRunning: boolean; message: string }
  | { type: "optimistic.retry"; messageId: string }
  | { type: "clear-error" };

export const initialConversationState: ConversationState = {
  messages: [],
  todos: [],
  pendingDecision: null,
  connection: "connecting",
  isRunning: false,
  error: null,
};

export function conversationReducer(state: ConversationState, action: ConversationAction): ConversationState {
  switch (action.type) {
    case "hydrate":
      return {
        ...state,
        messages: action.messages,
        todos: latestTodos(action.messages),
        pendingDecision: null,
        isRunning: action.messages.some((message) => message.status === "streaming"),
        error: null,
      };
    case "connection":
      return { ...state, connection: action.connection };
    case "optimistic.add":
      return state.messages.some((message) => message.id === action.message.id)
        ? state
        : { ...state, messages: [...state.messages, action.message], isRunning: true, error: null };
    case "optimistic.fail":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (message) => ({ ...message, status: "error" })),
        isRunning: action.keepRunning,
        error: action.message,
      };
    case "optimistic.retry":
      return {
        ...state,
        messages: updateMessage(state.messages, action.messageId, (message) => ({ ...message, status: "done" })),
        isRunning: true,
        error: null,
      };
    case "clear-error":
      return { ...state, error: null };
    case "event":
      return reduceEvent(state, action.event, action.conversationId);
  }
}

function reduceEvent(state: ConversationState, event: UiEvent, conversationId: string): ConversationState {
  switch (event.type) {
    case "message.start": {
      if (state.messages.some((message) => message.id === event.messageId)) {
        return { ...state, isRunning: true, error: null };
      }
      const message: ChatMessage = {
        id: event.messageId,
        conversationId,
        role: event.role,
        blocks: [],
        status: "streaming",
        createdAt: Date.now(),
      };
      return { ...state, messages: [...state.messages, message], isRunning: true, error: null };
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
    case "run.end":
      return { ...state, isRunning: false };
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
