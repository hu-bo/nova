import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createAgentKernel, defineTool } from "../src/index.js";
import { basicLoopPlugin } from "../src/plugins/basic-loop/index.js";
import { contextPlugin } from "../src/plugins/context/index.js";
import { memorySessionPlugin } from "../src/plugins/session-memory/index.js";
import { toolRuntimePlugin } from "../src/plugins/tools/index.js";
import { ScriptedModel } from "./fixtures/scripted-model.js";
test("Agent uses one loop, commits paired tool results and retains conversation", async () => {
  let executions = 0;
  const tool = defineTool({
    name: "quote",
    description: "Quote total",
    effects: "read",
    inputSchema: z.object({ quantity: z.number(), price: z.number() }).strict(),
    outputSchema: z.object({ total: z.number() }),
    async execute(input) {
      executions++;
      return { total: input.quantity * input.price };
    },
  });
  const model = new ScriptedModel({
    one: [
      { tool: { name: "quote", input: { quantity: 3, price: 19 } } },
      { text: "Total 57." },
      {
        check: (request) => {
          assert.ok(
            request.messages.some((message) =>
              message.parts.some((part) => part.type === "text" && part.text === "Total 57."),
            ),
          );
        },
        text: "57 again.",
      },
    ],
  });
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    configure: async (ctx) => {
      await ctx.plugin(basicLoopPlugin());
      await ctx.plugin(toolRuntimePlugin());
      await ctx.plugin(contextPlugin());
      await ctx.plugin(memorySessionPlugin());
      await ctx.plugin(model.plugin);
    },
  });
  try {
    const agent = await kernel.createAgent({
      sessionId: "one",
      systemPrompt: "Use quote",
      tools: [tool],
      allowedTools: ["quote"],
    });
    const result = await agent.send({ text: "Quote" });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(result.text, "Total 57.");
    assert.equal(executions, 1);
    assert.equal((await agent.send({ text: "Repeat" })).text, "57 again.");
    assert.equal((await agent.compact()).reason, "CAPABILITY_UNAVAILABLE");
    assert.throws(() => kernel.tasks, { code: "CAPABILITY_UNAVAILABLE" });
    model.assertConsumed();
  } finally {
    await kernel.dispose();
  }
});
