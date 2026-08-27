import { afterEach, expect, it, vi } from "vitest";
import { createModel } from "./index.js";
import { openAiChatStream } from "./openai.js";
import type { ModelRequest } from "./types.js";

afterEach(() => vi.unstubAllGlobals());

it("supports OpenAI-compatible Chat Completions gateways", async () => {
  let url = "";
  let sent: any;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input, init) => {
      url = String(input);
      sent = JSON.parse(String(init?.body));
      return sse([
        { choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: { content: "!" }, finish_reason: "stop" }],
        },
        {
          choices: [],
          usage: { prompt_tokens: 3, completion_tokens: 2 },
        },
      ]);
    }),
  );

  const events = await collect(
    openAiChatStream(
      {
        provider: "gateway",
        wireApi: "chat-completions",
        baseUrl: "https://api.orcarouter.ai/v1",
        apiKey: "key",
        model: "qwen/qwen3.8-27b-free",
      },
      { max: 0 },
    )(request(), new AbortController().signal),
  );

  expect(url).toBe("https://api.orcarouter.ai/v1/chat/completions");
  expect(sent).toMatchObject({
    model: "qwen/qwen3.8-27b-free",
    stream: true,
    messages: [
      { role: "system", content: "Be useful" },
      { role: "user", content: "Hello" },
    ],
  });
  expect(events).toContainEqual({ type: "block.end", index: 0, block: { type: "text", text: "Hello!" } });
  expect(events).toContainEqual({ type: "usage", usage: { input: 3, output: 2 } });
  expect(events.at(-1)).toEqual({ type: "finish", stopReason: "stop" });
});

it("adds /v1 when an OpenAI-compatible provider gives its host as the base URL", async () => {
  let url = "";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) => {
      url = String(input);
      return sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]);
    }),
  );

  await collect(
    openAiChatStream({ provider: "openai", baseUrl: "https://api.aigcdesk.com", apiKey: "key", model: "test" }, {
      max: 0,
    })(request(), new AbortController().signal),
  );

  expect(url).toBe("https://api.aigcdesk.com/v1/chat/completions");
});

it("maps Chat Completions tool calls", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      sse([
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, id: "call-1", function: { name: "read", arguments: '{"path":"a"}' } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    ),
  );
  const events = await collect(
    openAiChatStream({ provider: "gateway", wireApi: "chat-completions", apiKey: "key", model: "test" }, { max: 0 })(
      request(),
      new AbortController().signal,
    ),
  );
  expect(events).toContainEqual({
    type: "block.end",
    index: 2,
    block: { type: "tool_call", callId: "call-1", name: "read", args: { path: "a" } },
  });
  expect(events.at(-1)).toEqual({ type: "finish", stopReason: "tool_use" });
});

function request(): ModelRequest {
  return {
    system: "Be useful",
    thinking: "off",
    messages: [{ id: "m1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "Hello" }] }],
    tools: [],
  };
}
function sse(events: unknown[]): Response {
  return new Response(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
async function collect<T>(events: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const event of events) result.push(event);
  return result;
}
