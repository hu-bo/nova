import { createConversationReader } from "../src/modules/conversations/index.js";
import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { Context, eventObservers, type AgentEvent } from "@nnova/harness";
import type { FastifyReply } from "fastify";
import type { Database } from "../database/index.js";
import { postgresSessionPlugin } from "../src/modules/runs/postgres-session-store.js";
import type { RunClaim, RunRepository } from "../src/modules/runs/run.repository.js";
import { followEvents } from "../src/modules/events/event-stream.js";
import { createEventService } from "../src/modules/events/index.js";
import { EventService } from "../src/modules/events/event.service.js";
import { SseSubscriber } from "../src/transport/sse.js";

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
