import { describe, expect, it, vi } from "vitest";
import { createAgent } from "./agent.js";
import { memoryStorage, type SessionStorage } from "./session/storage.js";
import { CheckpointConflict, type RunCheckpoint } from "./session/checkpoint.js";
import type { AgentConfig, AgentTool, ModelEvent, ModelRequest, StreamFn } from "./index.js";
import { z } from "./tool-schema.js";

const model = { provider: "openai", model: "test", apiKey: "test" } as AgentConfig["model"];
function config(storage: SessionStorage, stream: StreamFn, tools: AgentTool[] = []): AgentConfig {
  return {
    sessionId: "recovery",
    model,
    storage,
    stream,
    tools,
    toolConcurrency: 1,
    approvalPolicy: { default: "auto" },
    decide: async () => ({ kind: "approval", decision: "allow" }),
  };
}
function script(turns: ModelEvent[][], requests: ModelRequest[] = []): StreamFn {
  let i = 0;
  return async function* (request) {
    requests.push(request);
    yield* turns[i++] ?? [{ type: "finish", stopReason: "stop" }];
  };
}
const calls: ModelEvent[] = [
  { type: "block.end", index: 0, block: { type: "tool_call", callId: "edit-1", name: "edit", args: {} } },
  { type: "block.end", index: 1, block: { type: "tool_call", callId: "check-1", name: "check", args: {} } },
  { type: "finish", stopReason: "tool_use" },
];
const answer: ModelEvent[] = [
  { type: "block.end", index: 0, block: { type: "text", text: "Finished" } },
  { type: "finish", stopReason: "stop" },
];
function tool(name: string, execute: () => void): AgentTool {
  return {
    name,
    description: name,
    schema: z.object({}),
    risk: "none",
    execute: async () => {
      execute();
      return { status: "ok", content: [{ type: "text", text: `${name} saved` }], details: { name } };
    },
  };
}

describe("durable recovery", () => {
  it("saves thinking drafts while the provider is still generating and pauses promptly", async () => {
    const storage = memoryStorage();
    const stream: StreamFn = async function* (_request, signal) {
      yield { type: "block.start", index: 0, blockType: "thinking" };
      yield { type: "block.delta", index: 0, delta: "working" };
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    };
    const agent = createAgent(config(storage, stream));
    const task = agent.prompt("fix it");
    await vi.waitFor(
      async () =>
        expect((await storage.loadCheckpoint("recovery"))?.draft?.blocks).toEqual([
          { type: "thinking", text: "working" },
        ]),
      { timeout: 2500 },
    );
    await agent.pause("runner_disconnected");
    expect((await task).stopReason).toBe("paused");
    expect(agent.state.isStreaming).toBe(false);
    expect(await storage.loadEntries("recovery")).toHaveLength(1);
  });

  it("reuses a committed edit result after a crash before the rest of the batch", async () => {
    const base = memoryStorage();
    let crashed = false;
    const storage: SessionStorage = {
      ...base,
      async commit(id, change) {
        await base.commit(id, change);
        if (!crashed && change.record?.kind === "tool-finished" && change.record.callId === "edit-1") {
          crashed = true;
          throw new CheckpointConflict();
        }
      },
    };
    const edits = vi.fn();
    const checks = vi.fn();
    const tools = [tool("edit", edits), tool("check", checks)];
    await createAgent(config(storage, script([calls]), tools)).prompt("fix it");
    const before = (await base.loadCheckpoint("recovery"))!;
    expect(before.phase).toBe("tools");
    expect(checks).not.toHaveBeenCalled();
    const requests: ModelRequest[] = [];
    await createAgent(config(base, script([answer], requests), tools)).resume();
    const after = (await base.loadCheckpoint("recovery"))!;
    expect(after).toMatchObject({ runId: before.runId, status: "completed", turns: 2 });
    expect(edits).toHaveBeenCalledTimes(1);
    expect(checks).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(requests[0]?.messages)).toContain("edit saved");
  });

  it("does not execute a tool when its start record cannot be committed", async () => {
    const base = memoryStorage();
    const executed = vi.fn();
    const storage: SessionStorage = {
      ...base,
      async commit(id, change) {
        if (change.record?.kind === "tool-started") throw new Error("database unavailable");
        await base.commit(id, change);
      },
    };
    const result = await createAgent(config(storage, script([calls]), [tool("edit", executed)])).prompt("fix");
    expect(result.stopReason).toBe("error");
    expect(executed).not.toHaveBeenCalled();
  });

  it("does not start a side effect when ownership is lost during its start commit", async () => {
    const base = memoryStorage();
    let agent: ReturnType<typeof createAgent>;
    const storage: SessionStorage = {
      ...base,
      async commit(id, change) {
        await base.commit(id, change);
        if (change.record?.kind === "tool-started") void agent.pause("ownership_lost");
      },
    };
    const executed = vi.fn();
    agent = createAgent(config(storage, script([calls]), [tool("edit", executed)]));
    expect((await agent.prompt("edit")).stopReason).toBe("paused");
    expect(executed).not.toHaveBeenCalled();
  });

  it("finalizes a saved answer without asking the provider again", async () => {
    const base = memoryStorage();
    const storage: SessionStorage = {
      ...base,
      async commit(id, change) {
        if (change.record?.kind === "run-finished") throw new CheckpointConflict();
        await base.commit(id, change);
      },
    };
    await createAgent(config(storage, script([answer]))).prompt("answer");
    const requests: ModelRequest[] = [];
    await createAgent(config(base, script([], requests))).resume();
    expect(requests).toHaveLength(0);
    expect((await base.loadCheckpoint("recovery"))?.status).toBe("completed");
  });

  it("keeps retry limits, deadlines and cancellation across reconstruction", async () => {
    const storage = memoryStorage();
    const cp: RunCheckpoint = {
      runId: "same-run",
      version: 1,
      status: "paused",
      phase: "model",
      reason: "server_restart",
      turns: 2,
      recoveries: 3,
      startedAt: Date.now(),
      deadline: Date.now() + 60000,
      usage: { input: 12, output: 4 },
      draft: null,
    };
    await storage.commit("recovery", { expectedVersion: null, checkpoint: cp });
    const requests: ModelRequest[] = [];
    const agent = createAgent(config(storage, script([], requests)));
    await agent.resume();
    expect(await storage.loadCheckpoint("recovery")).toMatchObject({
      reason: "recovery_limit",
      turns: 2,
      usage: cp.usage,
    });
    await agent.abort();
    await createAgent(config(storage, script([], requests))).resume();
    expect(requests).toHaveLength(0);
    expect((await storage.loadCheckpoint("recovery"))?.status).toBe("cancelled");
  });

  it("rejects stale checkpoint writes rather than allowing two continuations", async () => {
    const storage = memoryStorage();
    await createAgent(config(storage, script([answer]))).prompt("hello");
    const cp = (await storage.loadCheckpoint("recovery"))!;
    await expect(storage.commit("recovery", { expectedVersion: cp.version - 1, checkpoint: cp })).rejects.toThrow(
      CheckpointConflict,
    );
  });

  it("honors cancellation while the initial context is still loading", async () => {
    const base = memoryStorage();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const storage: SessionStorage = {
      ...base,
      async loadEntries(id, leaf) {
        await waiting;
        return base.loadEntries(id, leaf);
      },
    };
    const requests: ModelRequest[] = [];
    const agent = createAgent(config(storage, script([answer], requests)));
    const task = agent.prompt("do not execute after cancellation");
    await agent.abort();
    release();
    expect((await task).stopReason).toBe("aborted");
    expect(requests).toHaveLength(0);
    expect((await base.loadCheckpoint("recovery"))?.status).toBe("cancelled");
  });

  it("bounds a provider that ignores cancellation and never yields a result", async () => {
    const storage = memoryStorage();
    const stream: StreamFn = async function* () {
      await new Promise(() => {});
      yield { type: "finish", stopReason: "stop" };
    };
    const agent = createAgent({ ...config(storage, stream), modelTimeoutMs: 20 });
    expect((await agent.prompt("hello")).stopReason).toBe("error");
    expect(agent.state.isStreaming).toBe(false);
  });

  it("stops repeated calls with identical results instead of cycling through new call IDs", async () => {
    const storage = memoryStorage();
    const execute = vi.fn();
    const turns: ModelEvent[][] = Array.from({ length: 4 }, (_, i) => [
      {
        type: "block.end",
        index: 0,
        block: {
          type: "tool_call",
          callId: `repeat-${i}`,
          name: "check",
          args: i % 2 ? { b: 2, a: 1 } : { a: 1, b: 2 },
        },
      },
      { type: "finish", stopReason: "tool_use" },
    ]);
    const agent = createAgent(config(storage, script(turns), [tool("check", execute)]));
    expect((await agent.prompt("check repeatedly")).stopReason).toBe("paused");
    expect(execute).toHaveBeenCalledTimes(3);
    expect((await storage.loadCheckpoint("recovery"))?.reason).toBe("no_progress");
    await createAgent(config(storage, script(turns), [tool("check", execute)])).resume();
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("pauses an unconfirmed tool timeout without asking the model to repeat the operation", async () => {
    const storage = memoryStorage();
    const execute = vi.fn(async () => new Promise<never>(() => {}));
    const stalled = { ...tool("edit", () => {}), execute };
    const requests: ModelRequest[] = [];
    const stream = script([[calls[0]!, { type: "finish", stopReason: "tool_use" }], answer], requests);
    const agent = createAgent({ ...config(storage, stream, [stalled]), toolTimeoutMs: 20 });
    expect((await agent.prompt("edit once")).stopReason).toBe("paused");
    expect(await storage.loadCheckpoint("recovery")).toMatchObject({ reason: "outcome_unknown" });
    expect(await storage.loadRecords("recovery")).toContainEqual(
      expect.objectContaining({ kind: "tool-finished", outcomeKnown: false }),
    );
    await createAgent(config(storage, stream, [stalled])).resume();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it("preserves a terminating tool outcome across a crash during batch completion", async () => {
    const base = memoryStorage();
    const storage: SessionStorage = {
      ...base,
      async commit(id, change) {
        await base.commit(id, change);
        if (change.entry?.kind === "message" && change.entry.message.blocks.some((b) => b.type === "tool_result"))
          throw new CheckpointConflict();
      },
    };
    const execute = vi.fn(async () => ({ status: "ok" as const, content: [], details: null, terminate: true }));
    const stop = { ...tool("edit", () => {}), execute };
    await createAgent(
      config(storage, script([[calls[0]!, { type: "finish", stopReason: "tool_use" }]]), [stop]),
    ).prompt("finish");
    expect(await base.loadCheckpoint("recovery")).toMatchObject({ phase: "finish", completion: "terminate" });
    const requests: ModelRequest[] = [];
    await createAgent(config(base, script([], requests), [stop])).resume();
    expect(await base.loadCheckpoint("recovery")).toMatchObject({ status: "completed" });
    expect(requests).toHaveLength(0);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
