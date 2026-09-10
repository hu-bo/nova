import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createAgent, CheckpointConflict, type AgentConfig, type RunCheckpoint } from "@nova/agent-core";
import { createPgStore } from "./pg-store.js";
import { pgSessionStorage } from "./pg-session-storage.js";
import { pgRunControl } from "./pg-run-control.js";
import { conversations, entries, messages, users } from "./schema.js";
import { createRuntimeRegistry } from "../modules/runtime/runtime-registry.js";

// Must point to a disposable, migrated database. Never default to DATABASE_URL/.env.
const url = process.env.NOVA_TEST_DATABASE_URL;
describe.skipIf(!url)("PostgreSQL durable runs", () => {
  let database: ReturnType<typeof createPgStore>;
  const userId = `recovery-test-${randomUUID()}`;
  const ids: string[] = [];
  const modelConfig = {
    provider: "openai" as const,
    endpoint: "https://example.com",
    model: "test",
    credential: "test",
    contextWindow: 100000,
    maxOutput: 1000,
    thinkingLevels: ["off" as const],
    parallelToolCalls: true,
    reasoningFormat: "none" as const,
    inputModalities: ["text" as const],
  };
  beforeAll(async () => {
    database = createPgStore(url!);
    await database.store.upsertUser({
      casdoorId: userId,
      username: userId,
      displayName: "Recovery test",
      role: "user",
      isActive: true,
      isAdmin: false,
    });
  });
  afterAll(async () => {
    for (const id of ids) await database.db.delete(conversations).where(eq(conversations.id, id));
    await database.db.delete(users).where(eq(users.casdoorId, userId));
    await database.close();
  });
  async function setup() {
    const conversation = await database.store.createConversation({
      userId,
      projectId: null,
      runnerId: null,
      title: "Recovery test",
      modelConfig,
    });
    ids.push(conversation.id);
    const storage = pgSessionStorage(database.db, conversation.id);
    const route = await database.store.routeConversation(userId, conversation.id);
    return { id: conversation.id, storage, route };
  }
  function cp(): RunCheckpoint {
    return {
      runId: randomUUID(),
      version: 1,
      status: "running",
      phase: "model",
      reason: null,
      turns: 0,
      recoveries: 0,
      startedAt: Date.now(),
      deadline: Date.now() + 60000,
      usage: { input: 0, output: 0 },
      draft: null,
    };
  }

  it("rejects missing or incomplete run storage before recovery can start", async () => {
    const schema = `startup_test_${randomUUID().replaceAll("-", "")}`;
    await database.client.unsafe(`CREATE SCHEMA ${schema}`);
    const isolatedUrl = new URL(url!);
    isolatedUrl.searchParams.set("options", `-c search_path=${schema}`);
    const isolated = createPgStore(isolatedUrl.toString());
    try {
      await expect(isolated.checkReady()).rejects.toThrow("Apply database migrations");
      await database.client.unsafe(`CREATE TABLE ${schema}.runs (conversation_id uuid)`);
      await expect(isolated.checkReady()).rejects.toThrow("Apply database migrations");
      await database.checkReady();
    } finally {
      await isolated.close();
      await database.client.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    }
  });

  it("commits drafts and rejects stale writes atomically", async () => {
    const { id, storage } = await setup();
    const checkpoint = cp();
    checkpoint.draft = {
      id: "draft",
      role: "assistant",
      createdAt: Date.now(),
      blocks: [{ type: "thinking", text: "still working" }],
    };
    await storage.commit(id, { expectedVersion: null, checkpoint });
    expect((await database.db.select().from(messages).where(eq(messages.conversationId, id)))[0]).toMatchObject({
      status: "streaming",
      blocks: checkpoint.draft.blocks,
    });
    await expect(
      storage.commit(id, {
        expectedVersion: 0,
        checkpoint: { ...checkpoint, version: 2 },
        entry: { id: "must-not-exist", parentId: null, ts: Date.now(), kind: "message", message: checkpoint.draft },
      }),
    ).rejects.toThrow(CheckpointConflict);
    expect(await database.db.select().from(entries).where(eq(entries.conversationId, id))).toHaveLength(0);
    expect((await storage.loadCheckpoint(id))?.version).toBe(1);
  });

  it("preserves every completed tool result and approved diff before run.end", async () => {
    const { id, storage } = await setup();
    let checkpoint = cp();
    const message = {
      id: "assistant",
      role: "assistant" as const,
      createdAt: Date.now(),
      blocks: [{ type: "tool_call" as const, callId: "write", name: "write_file", args: { path: "a.ts" } }],
    };
    checkpoint = { ...checkpoint, phase: "tools" };
    await storage.commit(id, {
      expectedVersion: null,
      checkpoint,
      entry: { id: "entry", parentId: null, ts: Date.now(), kind: "message", message },
    });
    await storage.appendRecord(id, {
      id: "approval",
      runId: checkpoint.runId,
      ts: Date.now(),
      kind: "decision-requested",
      decisionId: "d",
      request: {
        kind: "approval",
        decisionId: "d",
        callId: "write",
        toolName: "write_file",
        args: {},
        risk: "write",
        codeChanges: [{ path: "a.ts", oldText: "old", newText: "new" }],
      },
    });
    // A queued user message must not steal the target of the tool-result projection.
    await database.store.appendMessage({
      id: randomUUID(),
      conversationId: id,
      role: "user",
      blocks: [{ type: "text", text: "also check this" }],
      status: "done",
      createdAt: new Date(),
    });
    await storage.commit(id, {
      expectedVersion: 1,
      checkpoint: { ...checkpoint, version: 2 },
      record: {
        id: "receipt",
        runId: checkpoint.runId,
        ts: Date.now(),
        kind: "tool-finished",
        callId: "write",
        status: "ok",
        durationMs: 1,
        content: [{ type: "text", text: "file written" }],
        details: { path: "a.ts", bytes: 3 },
        outcomeKnown: true,
      },
    });
    const [saved] = await database.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, id), eq(messages.id, "assistant")));
    expect(saved?.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "tool_call", status: "ok" }),
        expect.objectContaining({
          type: "tool_result",
          blocks: [expect.objectContaining({ type: "diff", diff: expect.stringContaining("-old") })],
        }),
      ]),
    );
    expect(
      (await storage.loadRecords(id)).some((r) => r.kind === "tool-finished" && r.content?.[0]?.type === "text"),
    ).toBe(true);
  });

  it("allows only one database owner for a conversation and releases ownership", async () => {
    const { id } = await setup();
    const control = pgRunControl(database.db, database.client, database.store, () => null);
    const first = await control.claim(id);
    expect(first).not.toBeNull();
    expect(await control.claim(id)).toBeNull();
    await first!.release();
    const second = await control.claim(id);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it("rotates recovery candidates so an offline page cannot starve later runs", async () => {
    const expected = new Set<string>();
    for (let index = 0; index < 33; index += 1) {
      const { id, storage } = await setup();
      expected.add(id);
      await storage.commit(id, {
        expectedVersion: null,
        checkpoint: { ...cp(), status: "paused", reason: "runner_disconnected" },
      });
    }
    const control = pgRunControl(database.db, database.client, database.store, () => null);
    for (let page = 0; page < 3; page += 1) {
      for (const route of await control.candidates()) expected.delete(route.conversation.id);
    }
    expect(expected.size).toBe(0);
  });

  it("finishes an already committed answer while its Runner is offline", async () => {
    const { id, storage, route } = await setup();
    route.conversation.runnerId = "offline-runner";
    const checkpoint = { ...cp(), phase: "finish" as const, completion: "done" as const };
    await storage.commit(id, { expectedVersion: null, checkpoint });
    const control = pgRunControl(database.db, database.client, database.store, () => null);
    control.candidates = async () => [];
    const create = vi.fn(async () => {
      throw new Error("Must not create an execution runtime");
    });
    const runtime = createRuntimeRegistry(
      create,
      () => {},
      () => {},
      60000,
      control,
    );
    try {
      await runtime.resume!(route);
      expect(create).not.toHaveBeenCalled();
      expect(await storage.loadCheckpoint(id)).toMatchObject({ runId: checkpoint.runId, status: "completed" });
    } finally {
      await runtime.close!();
    }
  });

  it("restarts a paused run once, pauses on Runner loss, and resumes with its new generation", async () => {
    const { id, storage, route } = await setup();
    const checkpoint = { ...cp(), status: "paused" as const, reason: "server_restart" };
    await storage.commit(id, { expectedVersion: null, checkpoint });
    route.conversation.runnerId = "runner-test";
    let generation: string | null = "generation-1";
    let requests = 0;
    const created: Array<string | null> = [];
    const control = pgRunControl(database.db, database.client, database.store, () => generation);
    // Restrict this scheduler's candidate set to this test's conversation.
    control.candidates = async () => [route];
    const create = async () => {
      if (!generation) throw new Error("Runner is offline");
      created.push(generation);
      return createAgent({
        sessionId: id,
        model: { provider: "openai", model: "test", apiKey: "test" } as AgentConfig["model"],
        tools: [],
        storage,
        decide: async () => ({ kind: "approval", decision: "allow" }),
        stream: async function* (_request, signal) {
          requests += 1;
          if (generation === "generation-1")
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
          else yield { type: "block.end", index: 0, block: { type: "text", text: "recovered" } };
          yield { type: "finish", stopReason: signal.aborted ? "aborted" : "stop" };
        },
      });
    };
    const failures = vi.fn();
    const a = createRuntimeRegistry(create, () => {}, failures, 60000, control);
    const b = createRuntimeRegistry(create, () => {}, failures, 60000, control);
    try {
      await a.resume!(route);
      await expect(b.resume!(route)).rejects.toThrow("owned");
      await vi.waitFor(() => expect(requests).toBe(1));
      generation = null;
      await vi.waitFor(async () => expect((await storage.loadCheckpoint(id))?.status).toBe("paused"), {
        timeout: 4000,
      });
      generation = "generation-2";
      await vi.waitFor(
        async () =>
          expect(await storage.loadCheckpoint(id)).toMatchObject({ runId: checkpoint.runId, status: "completed" }),
        { timeout: 6000 },
      );
      expect(created).toEqual(["generation-1", "generation-2"]);
      expect(requests).toBe(2);
    } finally {
      await a.close!();
      await b.close!();
    }
  }, 15000);
});
