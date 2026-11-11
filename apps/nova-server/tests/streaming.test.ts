import { createConversationReader } from "../src/modules/conversations/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  Context,
  createAgentKernel,
  eventObservers,
  modelRouter,
  type AgentEvent,
  type ModelChunk,
  type ModelStepRequest,
  type ModelAdapter,
} from "@nnova/harness";
import { createLogger } from "@hquant/logger-js";
import type { FastifyReply } from "fastify";
import type { Database } from "../database/index.js";
import { postgresSessionPlugin } from "../src/modules/runs/postgres-session-store.js";
import type { RunClaim, RunRepository } from "../src/modules/runs/run.repository.js";
import { followEvents } from "../src/modules/events/event-stream.js";
import { createEventService } from "../src/modules/events/index.js";
import { EventService } from "../src/modules/events/event.service.js";
import { SseSubscriber } from "../src/transport/sse.js";
import { configuredModelPlugin } from "../src/modules/runs/configured-model.js";
import { disabledUploadStorage } from "../src/modules/attachments/upload-storage.js";
import { nativeBlocks } from "../src/modules/runs/run-dto.js";

test("message projection preserves block identity and excludes opaque provider metadata", () => {
  const signature = "PRIVATE-PROVIDER-SIGNATURE";
  const metadata = { anthropic: { signature } };
  const blocks = nativeBlocks(
    [
      { id: "reasoning-1", type: "thinking", text: "First thought", metadata },
      { id: "reasoning-2", type: "thinking", text: "Second thought", metadata },
      { id: "source-1", type: "source", uri: "https://example.com", metadata },
    ],
    [],
    "message",
  );
  assert.deepEqual(
    blocks.map((block) => block.id),
    ["reasoning-1", "reasoning-2", "source-1"],
  );
  assert.ok(!JSON.stringify(blocks).includes(signature));
});

test("SSE follows active output promptly, backs off while idle and stops on disconnect", async (t) => {
  const reads: number[] = [];
  const frames: string[] = [];
  let sequence = 0n;
  let available = true;
  let notifyRead = () => {};
  const nextRead = async () => {
    await new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    await setImmediate();
  };
  const query = {
    from: () => query,
    where: () => query,
    orderBy: () => query,
    limit: async () => {
      reads.push(Date.now());
      notifyRead();
      if (!available) return [];
      sequence++;
      return [
        {
          sequence,
          runId: "run-1",
          type: "text.delta",
          payload: { messageId: "m", blockId: "b", offset: Number(sequence - 1n), text: "字" },
        },
      ];
    },
  };
  const db = { select: () => query } as unknown as Database;
  const heartbeat = setInterval(() => {}, 60_000);
  const subscriber = new SseSubscriber(
    {
      raw: {
        writableLength: 0,
        write: (frame: string) => {
          frames.push(frame);
          return true;
        },
        end: () => {},
      },
    } as unknown as FastifyReply,
    { heartbeatMs: 60_000, queueFrames: 256, queueBytes: 1_000_000 },
    heartbeat,
  );
  t.after(() => subscriber.close());
  const following = followEvents({
    service: createEventService(db, createConversationReader(db)),
    subscriber,
    conversationId: "c",
    cursor: "0",
  });
  await setImmediate();
  await nextRead();
  await nextRead();
  assert.equal(frames.length, 3);
  assert.match(frames[2]!, /id: c:3/);
  available = false;
  for (let index = 0; index < 6; index++) await nextRead();
  available = true;
  await nextRead();
  await nextRead();
  assert.match(frames.at(-1)!, /id: c:5/);
  subscriber.close();
  await following;
  // Check cadence with tolerance for the OS scheduler; no artificial token pacing is involved.
  const expectedDelays = [50, 50, 50, 100, 200, 400, 800, 1000, 1000, 50];
  expectedDelays.forEach((expected, index) => {
    const elapsed = reads[index + 1]! - reads[index]!;
    assert.ok(elapsed >= expected - 5 && elapsed < expected + 500, `read ${index}: ${elapsed}ms`);
  });
  assert.equal(reads.length, 11);
});

test("stream persistence flushes within 50ms and retains delta order", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const batches: AgentEvent[][] = [];
  const repository = {
    publishNativeEvents: async (_claim: RunClaim, _id: string, events: readonly AgentEvent[]) => {
      batches.push([...events]);
    },
  } as unknown as RunRepository;
  const context = new Context("session");
  await context.plugin(postgresSessionPlugin(repository, { id: "r", conversationId: "c" } as RunClaim));
  await context.ready();
  t.after(() => context.dispose());
  const observer = context.collect(eventObservers)[0]!;
  observer.observe({ type: "message.started", sessionId: "c", runId: "r", messageId: "m" });
  const delta: AgentEvent = {
    type: "assistant.delta",
    sessionId: "c",
    runId: "r",
    messageId: "m",
    blockId: "b",
    contentType: "text",
    text: "第一段",
  };
  observer.observe(delta);
  t.mock.timers.tick(49);
  await setImmediate();
  assert.equal(batches.length, 0);
  observer.observe({ ...delta, text: "第二段" });
  t.mock.timers.tick(1);
  await setImmediate();
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0]!.filter((event) => event.type === "assistant.delta").map((event) => event.text),
    ["第一段", "第二段"],
  );
});

test("configured model delegates protocol handling and logs safe correlated failures", async (t) => {
  const secret = "DO-NOT-LOG-MODEL-PAYLOAD";
  const frame = (value: unknown) => `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
  const content = frame({ choices: [{ index: 0, delta: { content: secret }, finish_reason: null }] });
  const finish = frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
  const done = frame("[DONE]");
  const scenarios = [
    { name: "valid OpenAI", data: content + finish + done, protocol: "openai", status: 200 },
    {
      name: "valid Anthropic",
      data:
        frame({
          type: "message_start",
          message: {
            id: "msg",
            type: "message",
            role: "assistant",
            model: "fixture",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        }) +
        frame({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
        frame({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: secret } }) +
        frame({ type: "content_block_stop", index: 0 }) +
        frame({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        }) +
        frame({ type: "message_stop" }),
      protocol: "anthropic",
      status: 200,
    },
    { name: "missing DONE", data: content + finish, protocol: "openai", status: 200 },
    {
      name: "legacy MiniMax OpenAI route completes without DONE",
      data: content + finish,
      protocol: "openai",
      reasoningFormat: "openai",
      status: 200,
    },
    {
      name: "MiniMax adapter separates reasoning and completes without DONE",
      data:
        frame({ choices: [{ index: 0, delta: { reasoning_content: secret }, finish_reason: null }] }) +
        content +
        finish,
      protocol: "openai",
      adapterId: "minimax",
      reasoningFormat: "minimax",
      status: 200,
    },
    {
      name: "missing finish reason",
      data: content + done,
      protocol: "openai",
      status: 200,
      failure: "MODEL_PROTOCOL",
    },
    {
      name: "incomplete frame",
      data: content + `data: ${secret}`,
      protocol: "openai",
      status: 200,
      failure: "MODEL_PROTOCOL",
    },
    {
      name: "malformed JSON",
      data: frame(secret),
      protocol: "openai",
      status: 200,
      failure: "MODEL_PROTOCOL",
    },
    {
      name: "invalid tool JSON",
      data:
        frame({
          choices: [
            {
              index: 0,
              delta: { tool_calls: [{ index: 0, id: "call", function: { name: "bash", arguments: secret } }] },
              finish_reason: "tool_calls",
            },
          ],
        }) + done,
      protocol: "openai",
      status: 200,
      failure: "MODEL_PROTOCOL",
    },
    {
      name: "upstream error",
      data: frame({ error: { message: secret, type: "provider_error", code: "provider_error" } }),
      protocol: "openai",
      status: 200,
      failure: "MODEL_REQUEST_FAILED",
    },
    {
      name: "HTTP error",
      data: secret,
      protocol: "openai",
      status: 429,
      failure: "MODEL_RATE_LIMITED",
    },
    { name: "network error", data: "", protocol: "openai", status: 200, transportError: true },
    {
      name: "CRLF split across reads",
      data: (content + finish + done).replace(/\n/g, "\r\n"),
      protocol: "openai",
      status: 200,
      split: true,
    },
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario.name, async (t) => {
      const logs: Record<string, unknown>[] = [];
      const logger = createLogger(
        "nova-server",
        { environment: "test", level: "debug" },
        {
          write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>),
        },
      );
      const transportError = new TypeError(secret, { cause: Object.assign(new Error(secret), { code: "ECONNRESET" }) });
      t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
        if ("adapterId" in scenario) {
          assert.ok(typeof init?.body === "string");
          const body: unknown = JSON.parse(init.body);
          assert.ok(body && typeof body === "object" && "reasoning_split" in body);
          assert.equal(body.reasoning_split, true);
        }
        if ("transportError" in scenario) throw transportError;
        const data = new TextEncoder().encode(scenario.data);
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            if ("split" in scenario) {
              for (const byte of data) controller.enqueue(Uint8Array.of(byte));
            } else controller.enqueue(data);
            controller.close();
          },
        });
        return new Response(body, {
          status: scenario.status,
          headers: { "content-type": "text/event-stream", "x-request-id": "upstream-123" },
        });
      });
      const now = new Date();
      const route: Parameters<typeof configuredModelPlugin>[0] = {
        credential: secret,
        provider: {
          id: "provider",
          adapterId: "adapterId" in scenario ? scenario.adapterId : null,
          protocol: scenario.protocol,
          name: "provider",
          baseUrl: "https://provider.invalid/v1",
          credentialCiphertext: secret,
          credentialMasked: "masked",
          enabled: true,
          isPublic: true,
          ownerId: null,
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
        model: {
          id: "model",
          providerId: "provider",
          publicName: "model",
          upstreamName: "upstream",
          contextWindow: "100000",
          maxOutput: "4096",
          thinkingLevels: ["medium"],
          parallelToolCalls: true,
          reasoningFormat: "reasoningFormat" in scenario ? scenario.reasoningFormat : "none",
          inputModalities: ["text"],
          enabled: true,
          priceIn: "0",
          priceOut: "0",
          priceCacheRead: "0",
          deletedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      };
      let adapter: ModelAdapter | undefined;
      const kernel = await createAgentKernel({
        maxConcurrentRuns: 1,
        configure: async (context) => {
          await context.plugin(configuredModelPlugin(route, disabledUploadStorage(), "owner", logger));
          context.onReady(() => {
            adapter = context.resolve(modelRouter);
          });
        },
      });
      t.after(() => kernel.dispose());
      assert.ok(adapter);
      const request: ModelStepRequest = {
        sessionId: "conversation",
        runId: "run",
        stepId: "step",
        signal: new AbortController().signal,
        messages: [{ role: "user", parts: [{ type: "text", text: secret }] }],
        tools: [],
        reasoningEffort: "medium",
      };
      const chunks: ModelChunk[] = [];
      const consume = async () => {
        for await (const chunk of adapter.stream(request)) chunks.push(chunk);
      };
      if ("failure" in scenario) {
        await assert.rejects(consume, { code: scenario.failure });
        const failure = logs.find((entry) => entry.msg === "Model stream failed")!;
        assert.equal(failure.errorCode, scenario.failure);
      } else if ("transportError" in scenario) {
        await assert.rejects(consume, { code: "MODEL_TRANSPORT" });
        assert.equal(logs.find((entry) => entry.msg === "Model stream failed")!.errorCode, "MODEL_TRANSPORT");
      } else {
        await consume();
        assert.deepEqual(chunks.at(-1), { type: "finished", reason: "stop" });
        const completed = chunks.find((chunk) => chunk.type === "message.completed");
        assert.ok(completed?.type === "message.completed");
        assert.equal(
          completed.message.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          secret,
        );
        if ("adapterId" in scenario)
          assert.equal(completed.message.parts.find((part) => part.type === "thinking")?.text, secret);
        assert.ok(logs.some((entry) => entry.msg === "Model stream completed"));
      }
      for (const entry of logs) {
        assert.equal(entry.conversationId, "conversation");
        assert.equal(entry.runId, "run");
        assert.equal(entry.stepId, "step");
        assert.equal(entry.modelId, "model");
        assert.equal(entry.protocol, scenario.protocol);
      }
      assert.ok(!JSON.stringify(logs).includes(secret));
    });
  }
});
