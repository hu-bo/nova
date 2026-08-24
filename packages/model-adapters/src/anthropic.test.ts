import { afterEach, expect, it, vi } from "vitest";
import type { ModelRequest } from "./types.js";
import { anthropicStream } from "./anthropic.js";
import { createModel } from "./index.js";

afterEach(() => vi.unstubAllGlobals());

it("maps Anthropic text, usage, finish, and tool results", async () => {
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ]);
    }),
  );

  const request: ModelRequest = {
    system: "system",
    tools: [],
    messages: [
      {
        id: "m1",
        role: "user",
        createdAt: 1,
        blocks: [{ type: "tool_result", callId: "c1", status: "error", content: [{ type: "text", text: "bad" }] }],
      },
    ],
  };
  const events = await collect(
    anthropicStream({ provider: "anthropic", model: "claude", apiKey: "key" }, { max: 0 })(
      request,
      new AbortController().signal,
    ),
  );
  expect(events).toContainEqual({ type: "block.end", index: 0, block: { type: "text", text: "hello" } });
  expect(events).toContainEqual({ type: "usage", usage: { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 } });
  expect(events.at(-1)).toEqual({ type: "finish", stopReason: "stop" });
  expect(sent.messages[0].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1", is_error: true });
});

it("classifies only explicit context overflow as a typed failure", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response('{"error":{"message":"prompt is too long"}}', { status: 400 })),
  );
  const events = await collect(
    anthropicStream({ provider: "anthropic", model: "claude", apiKey: "key" }, { max: 0 })(
      { system: "", messages: [], tools: [] },
      new AbortController().signal,
    ),
  );
  expect(events).toEqual([
    {
      type: "finish",
      stopReason: "error",
      errorMessage: expect.stringContaining("context overflow"),
      errorCode: "context_overflow",
    },
  ]);
});

it("routes a gateway model through DeepSeek's Anthropic format", async () => {
  let url = "";
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      url = String(input);
      sent = JSON.parse(String(init?.body));
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    }),
  );

  const model = createModel({
    provider: "gateway",
    protocol: "anthropic",
    reasoningFormat: "deepseek",
    model: "deepseek-pro",
    baseUrl: "https://gateway.example/anthropic",
    apiKey: "key",
  });
  await collect(
    model.stream(
      {
        system: "",
        thinking: "max",
        tools: [],
        messages: [
          {
            id: "m1",
            role: "assistant",
            createdAt: 1,
            blocks: [{ type: "thinking", text: "keep this", signature: "sig" }],
          },
        ],
      },
      new AbortController().signal,
    ),
  );

  expect(url).toBe("https://gateway.example/anthropic/v1/messages");
  expect(sent.thinking).toEqual({ type: "enabled" });
  expect(sent.output_config).toEqual({ effort: "max" });
  expect(sent.messages[0].content[0]).toEqual({ type: "thinking", thinking: "keep this", signature: "sig" });
});

it("uses MiniMax Anthropic thinking control and preserves its signed thinking block", async () => {
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return sse([
        { type: "message_start", message: { usage: { input_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "plan" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ]);
    }),
  );

  const events = await collect(
    anthropicStream(
      {
        provider: "gateway",
        protocol: "anthropic",
        reasoningFormat: "minimax",
        model: "minimax-m3",
        apiKey: "key",
      },
      { max: 0 },
    )({ system: "", thinking: "high", tools: [], messages: [] }, new AbortController().signal),
  );

  expect(sent.thinking).toEqual({ type: "adaptive" });
  expect(events).toContainEqual({
    type: "block.end",
    index: 0,
    block: { type: "thinking", text: "plan", signature: "signed" },
  });
});

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
