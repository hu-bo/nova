import { afterEach, expect, it, vi } from "vitest";
import { createModel } from "./index.js";
import { openAiResponsesStream } from "./responses.js";
import type { ModelRequest } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

it("sends Responses API input and streams text with usage", async () => {
  let url = "";
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      url = String(input);
      sent = JSON.parse(String(init?.body));
      return sse([
        { type: "response.output_text.delta", output_index: 0, delta: "hello" },
        { type: "response.output_text.done", output_index: 0, text: "hello" },
        {
          type: "response.completed",
          response: {
            usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
          },
        },
      ]);
    }),
  );

  const events = await collect(
    openAiResponsesStream(
      {
        provider: "gateway",
        model: "test",
        apiKey: "key",
        baseUrl: "https://example.com/v1",
      },
      { max: 0 },
    )(request(), new AbortController().signal),
  );

  expect(url).toBe("https://example.com/v1/responses");
  expect(sent).toMatchObject({
    model: "test",
    stream: true,
    instructions: "Be useful",
    input: [{ role: "user", content: "hello" }],
    tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
    max_output_tokens: 100,
    reasoning: { effort: "high" },
  });
  expect(events).toContainEqual({ type: "block.end", index: 0, block: { type: "text", text: "hello" } });
  expect(events).toContainEqual({ type: "usage", usage: { input: 4, output: 2, cacheRead: 1 } });
  expect(events.at(-1)).toEqual({ type: "finish", stopReason: "stop" });
});

it("maps Responses function calls and prior tool results", async () => {
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      sent = JSON.parse(String(init?.body));
      return sse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", call_id: "call-2", name: "read", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"path":"a"}' },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { type: "function_call", call_id: "call-2", name: "read", arguments: '{"path":"a"}' },
        },
        { type: "response.completed", response: {} },
      ]);
    }),
  );

  const input = request();
  input.messages = [
    {
      id: "assistant",
      role: "assistant",
      createdAt: 1,
      blocks: [{ type: "tool_call", callId: "call-1", name: "read", args: { path: "old" } }],
    },
    {
      id: "user",
      role: "user",
      createdAt: 2,
      blocks: [{ type: "tool_result", callId: "call-1", status: "ok", content: [{ type: "text", text: "done" }] }],
    },
  ];
  const events = await collect(
    openAiResponsesStream(
      {
        provider: "gateway",
        model: "test",
        apiKey: "key",
      },
      { max: 0 },
    )(input, new AbortController().signal),
  );

  expect(sent.input).toEqual([
    { type: "function_call", call_id: "call-1", name: "read", arguments: '{"path":"old"}' },
    { type: "function_call_output", call_id: "call-1", output: "done" },
  ]);
  expect(events).toContainEqual({
    type: "block.end",
    index: 0,
    block: { type: "tool_call", callId: "call-2", name: "read", args: { path: "a" } },
  });
  expect(events.at(-1)).toEqual({ type: "finish", stopReason: "tool_use" });
});

it("selects the Responses adapter by default", async () => {
  const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    sse([{ type: "response.completed", response: {} }]),
  );
  vi.stubGlobal("fetch", fetch);
  const model = createModel({ provider: "gateway", model: "test", apiKey: "key" });

  await collect(model.stream({ system: "", messages: [], tools: [] }, new AbortController().signal));

  expect(String(fetch.mock.calls[0]?.[0])).toBe("https://api.openai.com/v1/responses");
});

function request(): ModelRequest {
  return {
    system: "Be useful",
    thinking: "high",
    maxOutput: 100,
    messages: [{ id: "m1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "hello" }] }],
    tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
  };
}

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
