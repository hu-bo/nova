export type AgentEvent = {
  sessionId: string;
  runId: string;
  schemaVersion?: 1;
  eventId?: string;
  namespace?: string;
  seq?: number;
  timestamp?: number;
} & (
  | { type: "run.started" }
  | { type: "message.started"; messageId: string }
  | { type: "assistant.delta"; messageId: string; blockId: string; contentType: "text" | "thinking"; text: string }
  | { type: "assistant.reset"; messageId: string; blockId: string; attempt: number }
  | { type: "message.committed"; messageId: string }
  | { type: "tool.started"; executionId: string; callId: string; name: string }
  | {
      type: "tool.output";
      executionId: string;
      callId: string;
      channel: "stdout" | "stderr";
      offset: number;
      text: string;
    }
  | {
      type: "tool.finished";
      executionId: string;
      name: string;
      status: "succeeded" | "failed";
    }
  | {
      type: "run.finished";
      status: "succeeded" | "failed" | "cancelled" | "timed_out";
    }
);
export interface EventObserver {
  observe(event: AgentEvent): void | Promise<void>;
}

export interface EventJournal {
  publish(event: AgentEvent): void;
  snapshot(): readonly AgentEvent[];
  events(afterSequence?: number): AsyncIterable<AgentEvent>;
}
