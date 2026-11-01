import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { createAgentKernel, definePlugin, defineTool } from "../src/index.js";
import { basicLoopPlugin } from "../src/plugins/basic-loop/index.js";
import { contextPlugin } from "../src/plugins/context/index.js";
import { memorySessionPlugin } from "../src/plugins/session-memory/index.js";
import { toolRuntimePlugin } from "../src/plugins/tools/index.js";
import { summaryCompactionPlugin } from "../src/plugins/compaction/index.js";
import { telemetryPlugin } from "../src/plugins/telemetry/index.js";
import { mcpPlugin } from "../src/plugins/mcp/index.js";
import { ScriptedModel } from "./fixtures/scripted-model.js";
import type { Context } from "../src/contracts/runtime.js";
import type { AgentExecutor } from "../src/contracts/agent.js";
import { agentExecutor, sessionPersistence } from "../src/contracts/capabilities.js";
import { FrameworkError } from "../src/contracts/errors.js";
import { sessionCheckpointPolicyPlugin } from "../src/plugins/session-checkpoint-policy/index.js";
import { memoryTaskStorePlugin } from "../src/plugins/task-store-memory/index.js";
import { memoryTaskQueuePlugin } from "../src/plugins/queue-memory/index.js";
import { taskEnginePlugin } from "../src/plugins/task-engine/index.js";
import { agentTaskPlugin } from "../src/plugins/agent-task/index.js";

function basePlugins(model: ScriptedModel) {
  return async (context: Context) => {
    await context.plugin(memorySessionPlugin());
    await context.plugin(model.plugin);
    await context.plugin(contextPlugin());
    await context.plugin(toolRuntimePlugin());
    await context.plugin(basicLoopPlugin());
  };
}

test("compaction creates a bounded summary without changing the message owner", async () => {
  const model = new ScriptedModel({
    compact: [
      { text: "first" },
      { text: "second" },
      { text: "third" },
      { text: "fourth" },
      { text: "fifth" },
      {
        check(request) {
          const text = request.messages
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          assert.match(text, /first/);
          assert.match(text, /fifth/);
        },
        text: "after compaction",
      },
    ],
  });
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    onDiagnostic: () => undefined,
    configure: async (context) => {
      await basePlugins(model)(context);
      await context.plugin(
        summaryCompactionPlugin({
          keepRecentMessages: 2,
          maxSummaryCharacters: 2_000,
        }),
      );
    },
  });
  try {
    const agent = await kernel.createAgent({
      sessionId: "compact",
      systemPrompt: "Remember the conversation.",
      tools: [],
      allowedTools: [],
    });
    for (const text of ["one", "two", "three", "four", "five"])
      assert.equal((await agent.send({ text })).status, "succeeded");
    assert.deepEqual(await agent.compact(), { status: "compacted" });
    assert.equal((await agent.send({ text: "continue" })).text, "after compaction");
    await agent.dispose();
  } finally {
    await kernel.dispose();
  }
  model.assertConsumed();
});

test("telemetry observers are isolated and dynamic MCP tools use strict runtime validation", async () => {
  const observed: string[] = [];
  const model = new ScriptedModel({
    mcp: [{ tool: { name: "remote_echo", input: { message: "hello" } } }, { text: "remote result" }],
  });
  let calls = 0;
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    onDiagnostic: () => undefined,
    configure: async (context) => {
      await basePlugins(model)(context);
      await context.plugin(
        telemetryPlugin({
          observers: [
            {
              observe(event) {
                observed.push(event.type);
              },
            },
            {
              observe() {
                throw new Error("observer must not affect the run");
              },
            },
          ],
        }),
      );
      await context.plugin(
        mcpPlugin({
          client: {
            async listTools() {
              return [
                {
                  name: "remote_echo",
                  description: "Echo a message",
                  inputSchema: {
                    type: "object",
                    properties: { message: { type: "string", minLength: 1 } },
                    required: ["message"],
                    additionalProperties: false,
                  },
                  outputSchema: {
                    type: "object",
                    properties: { message: { type: "string" } },
                    required: ["message"],
                    additionalProperties: false,
                  },
                },
              ];
            },
            async call(_name, input) {
              calls++;
              return {
                message: z.object({ message: z.string() }).parse(input).message,
              };
            },
          },
        }),
      );
    },
  });
  try {
    const agent = await kernel.createAgent({
      sessionId: "mcp",
      systemPrompt: "Use the remote tool.",
      tools: [],
      allowedTools: ["remote_echo"],
    });
    const result = await agent.send({ text: "echo" });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(calls, 1);
    assert.ok(observed.includes("run.started"));
    assert.ok(observed.includes("run.finished"));
    await agent.dispose();
  } finally {
    await kernel.dispose();
  }
  model.assertConsumed();
});

test("defineTool still rejects coercion and unknown fields after dynamic extensions", () => {
  const tool = defineTool({
    name: "strict",
    description: "strict",
    effects: "read",
    inputSchema: z.object({ value: z.number() }).strict(),
    outputSchema: z.object({ ok: z.boolean() }).strict(),
    async execute() {
      return { ok: true };
    },
  });
  assert.throws(() => tool.prepare({ value: "1" }));
  assert.throws(() => tool.prepare({ value: 1, extra: true }));
});

test("tool budget failures keep the conversation history paired", async () => {
  const model = new ScriptedModel({
    budget: [
      { tool: { name: "strict", input: { value: 1 } } },
      { tool: { name: "strict", input: { value: 2 } } },
      {
        check(request) {
          assert.ok(
            request.messages.some((message) =>
              message.parts.some((part) => part.type === "tool-result" && part.status === "failed"),
            ),
          );
        },
        text: "recovered",
      },
    ],
  });
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    configure: async (context) => {
      await context.plugin(memorySessionPlugin());
      await context.plugin(model.plugin);
      await context.plugin(contextPlugin());
      await context.plugin(toolRuntimePlugin());
      await context.plugin(basicLoopPlugin({ maxToolCalls: 1 }));
    },
  });
  try {
    const agent = await kernel.createAgent({
      sessionId: "budget",
      systemPrompt: "Use strict.",
      tools: [
        defineTool({
          name: "strict",
          description: "Strict test tool",
          effects: "read",
          inputSchema: z.object({ value: z.number() }).strict(),
          outputSchema: z.object({ ok: z.boolean() }).strict(),
          async execute() {
            return { ok: true };
          },
        }),
      ],
      allowedTools: ["strict"],
    });
    const first = await agent.send({ text: "exhaust" });
    assert.equal(first.status, "failed");
    assert.equal(first.error?.code, "TOOL_LIMIT");
    assert.equal((await agent.send({ text: "recover" })).text, "recovered");
  } finally {
    await kernel.dispose();
  }
  model.assertConsumed();
});

test("agent tasks suspend and resume the same run without repeating the initial request", async () => {
  const executor: AgentExecutor = {
    async execute(run) {
      assert.equal(run.emit({ type: "run.started", sessionId: "suspended", runId: run.runId }), undefined);
      if (!run.resume)
        return {
          kind: "suspended",
          sessionId: "suspended",
          runId: run.runId,
          status: "waiting_input",
          continuationId: "continuation-1",
          text: "waiting",
          toolCalls: [],
          usage: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            reasoningTokens: null,
          },
        };
      return {
        kind: "completed",
        sessionId: "suspended",
        runId: run.runId,
        status: "succeeded",
        text: "resumed:" + JSON.stringify(run.resume.input),
        toolCalls: [],
        usage: {
          inputTokens: null,
          outputTokens: null,
          cachedInputTokens: null,
          reasoningTokens: null,
        },
      };
    },
    async compact() {
      return { status: "skipped", reason: "not supported" };
    },
  };
  const agentPlugin = definePlugin({
    manifest: {
      id: "test.suspended-executor",
      version: "1.0.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [agentExecutor],
    },
    setup(context) {
      context.provide(agentExecutor, executor);
    },
  });
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 1,
    configure: async (context) => {
      await context.plugin(memoryTaskStorePlugin({ maxTasks: 20, completedTtlMs: 60_000 }));
      await context.plugin(memoryTaskQueuePlugin({ maxPending: 20 }));
      await context.plugin(
        taskEnginePlugin({
          maxConcurrentTasks: 1,
          maxConcurrentPerKey: 1,
          maxNodesPerFlow: 10,
        }),
      );
      await context.plugin(agentTaskPlugin());
      await context.plugin(agentPlugin);
    },
  });
  try {
    await kernel.createAgent({
      sessionId: "suspended",
      systemPrompt: "",
      tools: [],
      allowedTools: [],
    });
    const task = kernel.tasks.submit({
      kind: "agent.send",
      version: 1,
      input: { sessionId: "suspended", text: "initial" },
      deadlineAt: Date.now() + 5_000,
    });
    for (let attempt = 0; attempt < 20 && task.snapshot().status !== "waiting"; attempt++)
      await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(task.snapshot().status, "waiting", JSON.stringify(task.snapshot()));
    assert.deepEqual(
      kernel.tasks.signal({
        taskId: task.taskId,
        waitId: "not-the-wait-id",
        eventId: "event-1",
        payload: "ignored",
      }),
      { status: "ignored" },
    );
    const waitId = task.snapshot().wait?.waitId;
    assert.ok(waitId);
    assert.deepEqual(
      kernel.tasks.signal({
        taskId: task.taskId,
        waitId,
        eventId: "event-1",
        payload: { approved: true },
      }),
      { status: "accepted" },
    );
    const result = await task.result();
    assert.equal(result.status, "succeeded");
    assert.match(JSON.stringify(result.output), /approved/);
  } finally {
    await kernel.dispose();
  }
});

test("checkpoint policy gates model and tool dispatch while notifications remain synchronous", async () => {
  for (const scenario of ["normal", "pre-step", "model", "tool", "next-step", "abort-tool"] as const) {
    const controller = new AbortController();
    let flushes = 0,
      effects = 0;
    const model = new ScriptedModel({
      checkpoint: [
        { tool: { name: "effect", input: {} } },
        {
          check(request) {
            const result = request.messages
              .flatMap((message) => message.parts)
              .find((part) => part.type === "tool-result");
            assert.ok(result?.type === "tool-result");
            assert.equal(result.status, scenario === "tool" ? "failed" : "succeeded");
          },
          text: "done",
        },
      ],
    });
    const persistence = definePlugin({
      manifest: {
        id: "test.checkpoints",
        version: "1.0.0",
        apiVersion: 1,
        scope: "session",
        requires: [],
        provides: [sessionPersistence],
      },
      setup(context) {
        context.provide(sessionPersistence, {
          async flush() {
            flushes++;
            const failAt = { "pre-step": 1, model: 2, tool: 3, "next-step": 4 }[
              scenario as "pre-step" | "model" | "tool" | "next-step"
            ];
            if (flushes === failAt) throw new FrameworkError("CHECKPOINT_FAILED", "Checkpoint was rejected");
            if (scenario === "abort-tool" && flushes === 3) {
              await Promise.resolve();
              controller.abort();
            }
          },
        });
      },
    });
    const kernel = await createAgentKernel({
      maxConcurrentRuns: 1,
      plugins: [
        memorySessionPlugin(),
        model.plugin,
        contextPlugin(),
        toolRuntimePlugin(),
        basicLoopPlugin(),
        persistence,
        sessionCheckpointPolicyPlugin(),
      ],
    });
    try {
      const agent = await kernel.createAgent({
        sessionId: "checkpoint",
        systemPrompt: "",
        allowedTools: ["effect"],
        tools: [
          defineTool({
            name: "effect",
            description: "effect",
            effects: "write",
            inputSchema: z.object({}),
            outputSchema: z.object({ done: z.boolean() }),
            async execute() {
              effects++;
              return { done: true };
            },
          }),
        ],
      });
      const result = await agent.send({ text: "start", signal: controller.signal });
      assert.equal(effects, scenario === "normal" || scenario === "next-step" ? 1 : 0, scenario);
      assert.equal(
        model.requests.length,
        scenario === "pre-step" || scenario === "model" ? 0 : scenario === "normal" || scenario === "tool" ? 2 : 1,
        scenario,
      );
      if (scenario === "abort-tool") {
        assert.equal(result.status, "cancelled");
        assert.equal(result.toolCalls[0]?.error?.code, "ABORTED_BEFORE_DISPATCH");
        assert.equal(result.toolCalls[0]?.outcome, "known");
      } else if (scenario === "normal" || scenario === "tool") {
        assert.equal(result.status, "succeeded");
        if (scenario === "tool") assert.equal(result.toolCalls[0]?.error?.code, "CHECKPOINT_FAILED");
        assert.equal(flushes, 5);
      } else {
        assert.equal(result.status, "failed");
        assert.equal(result.error?.code, "CHECKPOINT_FAILED");
      }
    } finally {
      await kernel.dispose();
    }
  }
});
