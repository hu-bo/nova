import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createAgentKernel, defineTool } from "../src/index.js";
import { aiSdkModelPlugin } from "../src/plugins/model-ai-sdk/index.js";
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
