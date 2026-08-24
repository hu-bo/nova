import { describe, expect, it } from "vitest";
import {
  BlockSchema,
  ConversationQuerySchema,
  DecisionRequestSchema,
  RunnerStateSchema,
  SendMessageSchema,
  SseEnvelopeSchema,
  pageSchema,
  ChatMessageSchema,
} from "./index.js";

describe("protocol schemas", () => {
  it("validates recursive tool result blocks", () => {
    const parsed = BlockSchema.parse({
      type: "tool_result",
      callId: "call-1",
      status: "ok",
      blocks: [{ type: "code", language: "ts", code: "const ok = true", startLine: 1 }],
    });
    expect(parsed.type).toBe("tool_result");
  });

  it("applies bounded pagination defaults", () => {
    expect(ConversationQuerySchema.parse({})).toEqual({ limit: 30 });
    expect(() => ConversationQuerySchema.parse({ limit: 101 })).toThrow();
    expect(RunnerStateSchema.parse("draining")).toBe("draining");
  });

  it("rejects empty messages and invalid decision risks", () => {
    expect(() => SendMessageSchema.parse({ text: "   " })).toThrow();
    expect(() => DecisionRequestSchema.parse({
      kind: "approval",
      decisionId: "decision-1",
      toolName: "bash",
      args: {},
      risk: "none",
    })).toThrow();
    expect(() => BlockSchema.parse({
      type: "tool_call",
      callId: "call-1",
      name: "bash",
      status: "running",
    })).toThrow();
  });

  it("allows an unbound runner and requires a safe model endpoint for conversations", async () => {
    const { CreateConversationSchema } = await import("./index.js");
    const input = {
      runnerId: "runner-1",
      modelConfig: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-5",
        credential: "secret",
        contextWindow: 128_000,
        maxOutput: 16_384,
        thinkingLevels: ["off", "high"],
        parallelToolCalls: true,
        reasoningFormat: "openai",
        inputModalities: ["text"],
      },
    };
    expect(CreateConversationSchema.parse(input).runnerId).toBe("runner-1");
    expect(CreateConversationSchema.parse({ modelConfig: input.modelConfig }).runnerId).toBeUndefined();
    expect(() => CreateConversationSchema.parse({
      ...input,
      modelConfig: { ...input.modelConfig, endpoint: "http://localhost:11434" },
    })).toThrow();
  });

  it("validates pages and SSE envelopes", () => {
    const message = {
      id: "message-1",
      conversationId: "conversation-1",
      role: "assistant",
      blocks: [{ type: "text", text: "done" }],
      status: "done",
      createdAt: 1,
    };
    expect(pageSchema(ChatMessageSchema).parse({ items: [message], nextCursor: null }).items).toHaveLength(1);
    expect(SseEnvelopeSchema.parse({
      id: "42",
      event: { type: "message.end", messageId: "message-1", status: "done" },
    }).id).toBe("42");
  });
});
