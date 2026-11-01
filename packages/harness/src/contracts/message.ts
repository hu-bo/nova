import type { ArtifactRef } from "./artifact.js";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type MessagePart = { readonly id?: string } & (
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "image" | "file"; reference: ArtifactRef }
  | {
      type: "source";
      id: string;
      uri: string;
      title?: string;
      version?: string;
    }
  | { type: "tool-call"; callId: string; name: string; input: JsonValue }
  | {
      type: "tool-result";
      callId: string;
      name: string;
      status: "succeeded" | "failed";
      value: JsonValue;
    }
);
export interface AgentMessage {
  readonly id?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  role: "system" | "user" | "assistant" | "tool";
  parts: readonly MessagePart[];
}
