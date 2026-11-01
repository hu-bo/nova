import type { Todo as ProductTodo } from "@nova/agent-ui-contracts";
import type { ReactNode } from "react";

export type ToolStatus = "queued" | "running" | "ok" | "error" | "cancelled" | "unknown";

export type Todo = ProductTodo & { note?: string | undefined };

export interface CodeChange {
  path: string;
  oldText: string;
  newText: string;
}

export type Block = { id?: string | undefined } & (
  | { type: "text"; text: string }
  | {
      type: "image";
      key: string;
      name: string;
      mimeType: string;
      url?: string | undefined;
      reference?: { conversationId: string; messageId: string; blockId: string } | undefined;
    }
  | { type: "thinking"; text: string }
  | { type: "code"; language: string; code: string; path?: string | undefined; startLine?: number | undefined }
  | { type: "diff"; path: string; diff: string; added: number; removed: number }
  | { type: "file"; path: string; kind: "file" | "dir"; size?: number | undefined }
  | { type: "tool_call"; callId: string; name: string; args: unknown; status: ToolStatus }
  | { type: "tool_result"; callId: string; status: "ok" | "error"; blocks: Block[] }
  | { type: "todo"; items: Todo[] }
  | { type: "error"; code: string; message: string }
  | { type: "custom"; name: string; fallback: string }
);

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "tool";
  blocks: Block[];
  status: "streaming" | "done" | "error" | "aborted";
  createdAt: number;
}

export type DecisionRequest =
  | {
      kind: "approval";
      decisionId: string;
      toolName: string;
      args: unknown;
      risk: "read" | "write" | "exec";
      codeChanges?: CodeChange[] | undefined;
      allowedScopes?: ("once" | "session")[] | undefined;
    }
  | {
      kind: "question";
      decisionId: string;
      question: string;
      options: { id: string; label: string }[];
      multiSelect: boolean;
      allowCustom: boolean;
    };

export type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason?: string | undefined }
  | { kind: "question"; optionIds: string[]; customText?: string | undefined };

export type ExtractBlock<T extends Block["type"]> = Extract<Block, { type: T }>;

export interface BlockRendererProps {
  block: Block;
  onOpenPath?: ((path: string, line?: number) => void) | undefined;
}

export type BlockRenderer = (props: BlockRendererProps) => ReactNode;
export type BlockRenderers = Record<string, BlockRenderer | undefined>;
