import { describe, expect, it, vi } from "vitest";
import { memoryStorage, z } from "@nova/agent-core";
import type { AgentTool, ModelEvent, ModelRequest, StreamFn } from "@nova/agent-core";
import { createHarness, type AgentModule, type HarnessAgentConfig } from "./index.js";

const noopTool = (name: string): AgentTool => ({
  name,
  description: name,
  schema: z.record(z.string(), z.unknown()),
  risk: "none",
  async execute() { return { status: "ok", content: [{ type: "text", text: "ok" }], details: { name } }; },
});

describe("createHarness", () => {
  it("fails fast on duplicate module, tool, and prompt names", () => {
    expect(() => createHarness({ modules: [{ id: "same" }, { id: "same" }] })).toThrow("duplicate module id");
    expect(() => createHarness({ modules: [{ id: "a", tools: [noopTool("read")] }, { id: "b", tools: [noopTool("read")] }] })).toThrow("duplicate tool name");
    expect(() => createHarness({ modules: [{ id: "a", prompts: [{ name: "rules", content: "a" }] }, { id: "b", prompts: [{ name: "rules", content: "b" }] }] })).toThrow("duplicate prompt name");
  });

  it("keeps module order, appends instance prompts, and freezes the snapshot", async () => {
    const modules: AgentModule[] = [
      { id: "a", tools: [noopTool("one")], prompts: [{ name: "p1", content: "first" }] },
      { id: "b", tools: [noopTool("two")], prompts: [{ name: "p2", content: "second" }] },
    ];
    const requests: ModelRequest[] = [];
    const harness = createHarness({ modules });
    modules.push({ id: "late", tools: [noopTool("late")] });
    const agent = harness.createAgent(baseConfig(captureStop(requests), { systemPrompt: [{ name: "p3", content: "third" }] }));
    await agent.prompt("go");
    expect(harness.moduleIds).toEqual(["a", "b"]);
    expect(harness.toolNames).toEqual(["one", "two"]);
    expect(requests[0]!.system.indexOf("first")).toBeLessThan(requests[0]!.system.indexOf("second"));
    expect(requests[0]!.system.indexOf("second")).toBeLessThan(requests[0]!.system.indexOf("third"));
    expect(() => (harness.toolNames as string[]).push("x")).toThrow();
  });

  it("composes guards monotonically and fails closed", async () => {
    const asked = vi.fn();
    const guardError = vi.fn();
    const harness = createHarness({
      modules: [
        { id: "ask", tools: [noopTool("work")], guards: [() => "ask"] },
        { id: "broken", guards: [() => { throw new Error("guard failed"); }] },
      ],
      onGuardError: guardError,
    });
    const agent = harness.createAgent(baseConfig(toolThenStop("work"), {
      decide: async request => { asked(); return request.kind === "approval" ? { kind: "approval", decision: "allow" } : { kind: "question", answers: [] }; },
    }));
    await agent.prompt("go");
    expect(asked).not.toHaveBeenCalled();
    expect(guardError).toHaveBeenCalledWith(expect.any(Error), "broken");
    const records = await baseStorage(agent).loadRecords(agent.sessionId);
    expect(records.some(record => record.kind === "tool-started")).toBe(false);
  });

  it("isolates observer sync errors and promise rejections", async () => {
    const seen: string[] = [];
    const errors = vi.fn();
    const harness = createHarness({
      modules: [{
        id: "observe",
        observers: [
          () => { throw new Error("sync"); },
          async () => { throw new Error("async"); },
          event => { seen.push(event.type); },
        ],
      }],
      onObserverError: errors,
    });
    const agent = harness.createAgent(baseConfig(captureStop([])));
    const result = await agent.prompt("go");
    await Promise.resolve();
    expect(result.stopReason).toBe("done");
    expect(seen).toContain("run.end");
    expect(errors.mock.calls.some(([, id]) => id === "observe")).toBe(true);
  });
});

let lastStorage = memoryStorage();
function baseConfig(stream: StreamFn, extra: Partial<HarnessAgentConfig> = {}): HarnessAgentConfig {
  lastStorage = memoryStorage();
  return {
    model: { provider: "openai" as const, model: "test" },
    stream,
    storage: lastStorage,
    decide: async () => ({ kind: "approval" as const, decision: "allow" as const }),
    ...extra,
  };
}

function baseStorage(_agent: unknown) { return lastStorage; }

function captureStop(requests: ModelRequest[]): StreamFn {
  return async function* (request) {
    requests.push(request);
    yield { type: "finish", stopReason: "stop" };
  };
}

function toolThenStop(name: string): StreamFn {
  let turn = 0;
  return async function* () {
    const events: ModelEvent[] = turn++ === 0
      ? [
          { type: "block.start", index: 0, blockType: "tool_call" },
          { type: "block.end", index: 0, block: { type: "tool_call", callId: "c1", name, args: {} } },
          { type: "finish", stopReason: "tool_use" },
        ]
      : [{ type: "finish", stopReason: "stop" }];
    for (const event of events) yield event;
  };
}
