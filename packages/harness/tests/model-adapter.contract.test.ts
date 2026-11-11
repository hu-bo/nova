import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import {
  createAgentKernel,
  defineTool,
  Context,
  admission,
  modelRouter,
  type AgentMessage,
  type ModelChunk,
  type ModelStepRequest,
} from "../src/index.js";
import { ResourceAdmission } from "../src/kernel/admission.js";
import {
  aiSdkModelPlugin,
  normalizeModelMessage,
  providerCatalog,
  resolveProviderId,
  type AiSdkModelConfig,
  type AiSdkModelOptions,
  type ProviderId,
} from "../src/plugins/model-ai-sdk/index.js";
import { basicLoopPlugin } from "../src/plugins/basic-loop/index.js";
import { contextPlugin } from "../src/plugins/context/index.js";
import { memorySessionPlugin } from "../src/plugins/session-memory/index.js";
import { toolRuntimePlugin } from "../src/plugins/tools/index.js";

test("real AI SDK adapter consumes chat SSE once per step and pairs tool responses", async () => {
  const requests: unknown[] = [];
  let executions = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("Expected a serialized request body.");
    const request: unknown = JSON.parse(init.body);
    requests.push(request);
    const first = requests.length === 1;
    const chunks = first
      ? [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: "call-1",
                      type: "function",
                      function: { name: "quote", arguments: '{"quantity":3}' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          },
        ]
      : [
          {
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: "Total 57." },
                finish_reason: null,
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: {
              prompt_tokens: 20,
              completion_tokens: 5,
              total_tokens: 25,
            },
          },
        ];
    const body =
      chunks
        .map(
          (chunk) =>
            "data: " +
            JSON.stringify({
              id: "chat-1",
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              ...chunk,
            }) +
            "\n\n",
        )
        .join("") + "data: [DONE]\n\n";
    return new Response(body, {
      headers: { "content-type": "text/event-stream" },
    });
  };
  const modelPlugin = aiSdkModelPlugin(
    {
      defaultModel: "fixture",
      models: [
        {
          id: "fixture",
          protocol: "openai-chat",
          apiKey: "test-only",
          baseURL: "https://model.invalid/v1",
          model: "fixture",
          contextWindow: 10000,
          maxOutputTokens: 1000,
        },
      ],
    },
    { fetch },
  );
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    configure: async (ctx) => {
      await ctx.plugin(modelPlugin);
      await ctx.plugin(memorySessionPlugin());
      await ctx.plugin(contextPlugin());
      await ctx.plugin(toolRuntimePlugin());
      await ctx.plugin(basicLoopPlugin());
    },
  });
  try {
    const tool = defineTool({
      name: "quote",
      description: "quote",
      effects: "read",
      inputSchema: z.object({ quantity: z.number() }).strict(),
      outputSchema: z.object({ total: z.number() }),
      async execute(input) {
        executions++;
        return { total: input.quantity * 19 };
      },
    });
    const agent = await kernel.createAgent({
      sessionId: "adapter",
      systemPrompt: "Use quote.",
      tools: [tool],
      allowedTools: ["quote"],
    });
    const result = await agent.send({ text: "Quote three." });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(result.text, "Total 57.");
    assert.equal(executions, 1);
    assert.equal(requests.length, 2);
    assert.equal(result.usage.inputTokens, 30);
    const second = z
      .object({
        messages: z.array(z.object({ role: z.string(), tool_call_id: z.string().optional() })),
      })
      .parse(requests[1]);
    assert.ok(second.messages.some((message) => message.role === "tool" && message.tool_call_id === "call-1"));
    assert.ok(!JSON.stringify(kernel.inspectPlugins()).includes("test-only"));
  } finally {
    await kernel.dispose();
  }
});

const frame = (data: unknown) => "data: " + JSON.stringify(data) + "\n\n";
function requestBody(init?: RequestInit): unknown {
  assert.ok(typeof init?.body === "string");
  const body: unknown = JSON.parse(init.body);
  return body;
}
function chatStream(finish = "stop", reasoning = ""): string {
  return (
    frame({ choices: [{ index: 0, delta: { content: "ok", reasoning_content: reasoning }, finish_reason: null }] }) +
    frame({
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
  );
}

function anthropicStream(tool = false): string {
  const events: unknown[] = [
    {
      type: "message_start",
      message: {
        id: "message",
        type: "message",
        role: "assistant",
        model: "fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "consider" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "signed-thinking" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "ok" } },
    { type: "content_block_stop", index: 1 },
  ];
  if (tool)
    events.push(
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "call-1", name: "quote", input: {} },
      },
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"quantity":3}' } },
      { type: "content_block_stop", index: 2 },
    );
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  );
  return events.map(frame).join("");
}

async function adapter(
  t: TestContext,
  provider: ProviderId,
  options: AiSdkModelOptions,
  route: Partial<AiSdkModelConfig["models"][number]> = {},
) {
  const context = new Context("kernel", { builtins: new Map([[admission.id, "kernel"]]) });
  context.provide(admission, new ResourceAdmission());
  t.after(() => context.dispose());
  await context.plugin(
    aiSdkModelPlugin(
      {
        defaultModel: "fixture",
        models: [
          {
            id: "fixture",
            provider,
            apiKey: "secret",
            model: "fixture",
            contextWindow: 20_000,
            maxOutputTokens: 8192,
            ...route,
          },
        ],
      },
      options,
    ),
  );
  await context.ready();
  return context.resolve(modelRouter);
}

async function consume(
  model: Awaited<ReturnType<typeof adapter>>,
  request: Partial<ModelStepRequest> = {},
): Promise<ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of model.stream({
    sessionId: "session",
    runId: "run",
    stepId: "step",
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    tools: [],
    signal: new AbortController().signal,
    ...request,
  }))
    chunks.push(chunk);
  return chunks;
}

test("registered providers map standard reasoning settings and support custom endpoints", async (t) => {
  const scenarios: { provider: ProviderId; effort: "medium" | "max" | "off"; expected: Record<string, unknown> }[] = [
    { provider: "openai", effort: "max", expected: { reasoning_effort: "max", max_completion_tokens: 8192 } },
    { provider: "anthropic", effort: "medium", expected: { thinking: { type: "enabled", budget_tokens: 4096 } } },
    { provider: "anthropic", effort: "off", expected: { thinking: { type: "disabled" } } },
    { provider: "deepseek", effort: "medium", expected: { thinking: { type: "enabled" }, reasoning_effort: "high" } },
    { provider: "deepseek", effort: "off", expected: { thinking: { type: "disabled" } } },
    { provider: "minimax", effort: "max", expected: { reasoning_effort: "max", reasoning_split: true } },
    { provider: "minimax-anthropic", effort: "medium", expected: { output_config: { effort: "medium" } } },
  ];
  for (const scenario of scenarios)
    await t.test(scenario.provider + " " + scenario.effort, async (t) => {
      const definition = providerCatalog.find((entry) => entry.id === scenario.provider)!;
      let observed: Record<string, unknown> | undefined;
      let endpoint = "";
      const model = await adapter(
        t,
        scenario.provider,
        {
          fetch: async (url, init) => {
            endpoint = url instanceof Request ? url.url : url.toString();
            observed = z.record(z.string(), z.unknown()).parse(requestBody(init));
            assert.equal(init?.redirect, "error");
            return new Response(definition.protocol === "anthropic" ? anthropicStream() : chatStream(), {
              headers: { "content-type": "text/event-stream" },
            });
          },
        },
        { baseURL: "https://custom.invalid/proxy/v1", parallelToolCalls: false },
      );
      const result = await consume(model, { reasoningEffort: scenario.effort });
      assert.ok(endpoint.startsWith("https://custom.invalid/proxy/v1/"));
      for (const [key, value] of Object.entries(scenario.expected)) assert.deepEqual(observed?.[key], value);
      assert.equal(result.at(-1)?.type, "finished");
      if (scenario.provider === "openai") assert.equal(observed?.max_tokens, undefined);
    });
});

test("Anthropic thinking signatures survive the shared stream and replay with tool results", async (t) => {
  const bodies: unknown[] = [];
  const model = await adapter(t, "anthropic", {
    fetch: async (_url, init) => {
      bodies.push(requestBody(init));
      return new Response(anthropicStream(true), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const tools = [
    {
      name: "quote",
      description: "quote",
      inputSchema: { type: "object", properties: { quantity: { type: "number" } }, required: ["quantity"] },
    },
  ] satisfies ModelStepRequest["tools"];
  const first = await consume(model, { tools, reasoningEffort: "medium" });
  const completed = first.find((chunk) => chunk.type === "message.completed");
  assert.equal(completed?.type, "message.completed");
  if (completed?.type !== "message.completed") return;
  const reasoning = completed.message.parts.find((part) => part.type === "thinking");
  assert.equal(
    reasoning?.metadata?.anthropic &&
      typeof reasoning.metadata.anthropic === "object" &&
      !Array.isArray(reasoning.metadata.anthropic)
      ? reasoning.metadata.anthropic.signature
      : undefined,
    "signed-thinking",
  );
  await consume(model, {
    tools,
    reasoningEffort: "medium",
    messages: [
      { role: "user", parts: [{ type: "text", text: "hello" }] },
      completed.message,
      {
        role: "tool",
        parts: [{ type: "tool-result", callId: "call-1", name: "quote", status: "succeeded", value: { total: 57 } }],
      },
    ],
  });
  const body = z
    .object({ messages: z.array(z.object({ role: z.string(), content: z.array(z.record(z.string(), z.unknown())) })) })
    .parse(bodies[1]);
  assert.ok(
    body.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((block) => block.type === "thinking" && block.signature === "signed-thinking"),
    ),
  );
  assert.ok(
    body.messages.some(
      (message) =>
        message.role === "user" &&
        message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "call-1"),
    ),
  );
});

test("compatible reasoning is replayed and object image references are resolved at the host boundary", async (t) => {
  const bodies: unknown[] = [];
  const resolved: string[] = [];
  const model = await adapter(
    t,
    "minimax",
    {
      resolveImageUrl: async (uri) => {
        resolved.push(uri);
        return "https://images.invalid/signed";
      },
      fetch: async (_url, init) => {
        bodies.push(requestBody(init));
        return new Response(chatStream("stop", "consider"), { headers: { "content-type": "text/event-stream" } });
      },
    },
    { images: true },
  );
  const input: AgentMessage = {
    role: "user",
    parts: [
      { type: "image", reference: { id: "image", uri: "nova-object:private", mediaType: "image/png", sizeBytes: 10 } },
    ],
  };
  const first = await consume(model, { messages: [input] });
  const completed = first.find((chunk) => chunk.type === "message.completed");
  assert.ok(completed?.type === "message.completed");
  assert.deepEqual(
    completed.message.parts.map((part) => ({ type: part.type, text: "text" in part ? part.text : undefined })),
    [
      { type: "thinking", text: "consider" },
      { type: "text", text: "ok" },
    ],
  );
  await consume(model, { messages: [input, completed.message] });
  assert.deepEqual(resolved, ["nova-object:private", "nova-object:private"]);
  for (const body of bodies) assert.equal(z.record(z.string(), z.unknown()).parse(body).reasoning_split, true);
  assert.ok(JSON.stringify(bodies[0]).includes("https://images.invalid/signed"));
  assert.ok(JSON.stringify(bodies[1]).includes('"reasoning_content":"consider"'));
});

test("legacy history normalizes to standard parts without duplicating existing reasoning", () => {
  const message: AgentMessage = {
    role: "assistant",
    parts: [{ type: "text", text: "answer" }],
    metadata: {
      anthropicContent: [
        { type: "thinking", thinking: "one", signature: "sig-1" },
        { type: "thinking", thinking: "two", signature: "sig-2" },
        { type: "text", text: "answer" },
      ],
    },
  };
  const normalized = normalizeModelMessage(message);
  assert.deepEqual(
    normalized.parts.map((part) => part.type),
    ["thinking", "thinking", "text"],
  );
  assert.equal(new Set(normalized.parts.map((part) => part.id)).size, 3);
  assert.equal(normalizeModelMessage(normalized), normalized);
  assert.deepEqual(
    normalizeModelMessage({ role: "assistant", parts: [], metadata: { reasoningContent: "old" } }).parts,
    [{ id: "thinking", type: "thinking", text: "old" }],
  );
  assert.equal(resolveProviderId({ protocol: "anthropic", reasoningFormat: "minimax" }), "minimax-anthropic");
});

test("shared stream accepts terminal finish without DONE and rejects truncation, invalid frames and unsafe errors", async (t) => {
  for (const scenario of [
    { name: "missing DONE", body: chatStream() },
    {
      name: "missing finish",
      body: frame({ choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }] }),
      code: "MODEL_PROTOCOL",
    },
    { name: "malformed JSON", body: "data: {bad\n\n", code: "MODEL_PROTOCOL" },
    { name: "HTTP rate limit", body: "provider-secret", status: 429, code: "MODEL_RATE_LIMITED" },
    { name: "HTTP authentication", body: "provider-secret", status: 401, code: "MODEL_AUTH_FAILED" },
    {
      name: "upstream error frame",
      body: frame({ error: { message: "provider-secret", type: "provider" } }),
      code: "MODEL_REQUEST_FAILED",
    },
    {
      name: "invalid tool arguments",
      body: frame({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", type: "function", function: { name: "quote", arguments: "provider-secret" } },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      }),
      code: "MODEL_PROTOCOL",
    },
    { name: "transport", body: "", throws: true, code: "MODEL_TRANSPORT" },
  ])
    await t.test(scenario.name, async (t) => {
      const model = await adapter(t, "openai-compatible", {
        fetch: async () => {
          if (scenario.throws) throw new Error("provider-secret");
          return new Response(scenario.body, {
            status: scenario.status ?? 200,
            headers: { "content-type": "text/event-stream" },
          });
        },
      });
      if (scenario.code)
        await assert.rejects(consume(model), (error: unknown) => {
          assert.ok(error instanceof Error && "code" in error);
          assert.equal(error.code, scenario.code);
          assert.ok(!error.message.includes("provider-secret"));
          return true;
        });
      else assert.equal((await consume(model)).at(-1)?.type, "finished");
    });
});

test("provider capability checks reject unsupported effort and undersized thinking budgets", async (t) => {
  for (const requestTimeoutMs of [-1, 0, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 32])
    assert.throws(
      () =>
        aiSdkModelPlugin(
          {
            defaultModel: "fixture",
            models: [
              {
                id: "fixture",
                provider: "openai",
                apiKey: "key",
                model: "fixture",
                contextWindow: 10000,
                maxOutputTokens: 1000,
              },
            ],
          },
          { requestTimeoutMs },
        ),
      { code: "INVALID_CONFIG" },
    );
  let requests = 0;
  const fetch: typeof globalThis.fetch = async () => {
    requests++;
    return new Response(chatStream());
  };
  const minimax = await adapter(t, "minimax", { fetch });
  await assert.rejects(consume(minimax, { reasoningEffort: "off" }), { code: "MODEL_CONFIG" });
  const anthropic = await adapter(t, "anthropic", { fetch }, { maxOutputTokens: 1024 });
  await assert.rejects(consume(anthropic, { reasoningEffort: "low" }), { code: "MODEL_CONFIG" });
  assert.equal(requests, 0);
});

test("stream cancellation reaches transport and iterator disposal releases its request", async (t) => {
  const controller = new AbortController();
  let started!: () => void;
  const fetching = new Promise<void>((resolve) => {
    started = resolve;
  });
  const model = await adapter(t, "openai-compatible", {
    fetch: async (_url, init) => {
      started();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("private abort reason")), { once: true });
      });
    },
  });
  const consuming = consume(model, { signal: controller.signal });
  await fetching;
  controller.abort();
  await assert.rejects(consuming, { code: "CANCELLED" });

  let signal: AbortSignal | null | undefined;
  const finite = await adapter(t, "openai-compatible", {
    fetch: async (_url, init) => {
      signal = init?.signal;
      return new Response(chatStream(), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const output = finite.stream({
    sessionId: "session",
    runId: "run",
    stepId: "step",
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
    tools: [],
    signal: new AbortController().signal,
  });
  const stream = output[Symbol.asyncIterator]();
  assert.equal((await stream.next()).done, false);
  await stream.return?.();
  assert.equal(signal?.aborted, true);
});

test("shared transport bounds output before the SDK parses an oversized frame", async (t) => {
  const model = await adapter(t, "openai-compatible", {
    fetch: async () =>
      new Response("data: " + "x".repeat(8 * 1024 * 1024), { headers: { "content-type": "text/event-stream" } }),
  });
  await assert.rejects(consume(model), { code: "MODEL_OUTPUT_LIMIT" });
});
