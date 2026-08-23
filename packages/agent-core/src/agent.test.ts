// testing.md §2：agent-core 行为测试。
// 纯编排行为使用本地测试工具；OS / FS / process 行为在 coding-agent integration 中经真实 Runner 验证。
import { describe, expect, it } from "vitest";
import type { ModelEvent, ModelRequest, StreamFn, Usage } from "@nova/model-adapters";
import { createAgent } from "./agent.js";
import { memoryStorage, type SessionStorage } from "./session/storage.js";
import { entry } from "./session/entry.js";
import { record, type Record as SessionRecord } from "./session/record.js";
import { requestDecision } from "./decision/decision.js";
import { createSubAgentGate } from "./sub-agent/spawn-agent.js";
import { z } from "./tool-schema.js";
import type { AgentHooks } from "./loop/hooks.js";
import type {
  AgentEvent, AgentTool, ApprovalPolicy, Block, ContentPart, Decide, DecisionResponse, Risk, ToolCall, ToolContext,
} from "./types.js";

// —— 测试缝隙 ——

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await delay(5);
  }
}

function textEvents(text: string, usage?: Usage): ModelEvent[] {
  return [
    { type: "block.start", index: 0, blockType: "text" },
    { type: "block.end", index: 0, block: { type: "text", text } },
    ...(usage ? [{ type: "usage", usage } as ModelEvent] : []),
    { type: "finish", stopReason: "stop" },
  ];
}

function toolEvents(calls: Array<{ name: string; args?: unknown; callId?: string }>, usage?: Usage): ModelEvent[] {
  const events: ModelEvent[] = [];
  calls.forEach((call, index) => {
    events.push({ type: "block.start", index, blockType: "tool_call" });
    events.push({ type: "block.end", index, block: { type: "tool_call", callId: call.callId ?? `${call.name}-call-${index}`, name: call.name, args: call.args ?? {} } });
  });
  if (usage) events.push({ type: "usage", usage });
  events.push({ type: "finish", stopReason: "tool_use" });
  return events;
}

function scripted(turns: ModelEvent[][]): { stream: StreamFn; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let turn = 0;
  const stream: StreamFn = async function* (request) {
    requests.push(request);
    const events = turns[turn++] ?? [{ type: "finish", stopReason: "stop" } as ModelEvent];
    for (const event of events) yield event;
  };
  return { stream, requests };
}

interface LocalToolOpts {
  status?: "ok" | "error";
  risk?: Risk;
  requiresContext?: boolean;
  executionMode?: "parallel" | "sequential";
  durationMs?: number;
  untilAborted?: boolean;                              // execute 挂起直到 ctx.signal abort
  onExecute?: (args: Record<string, unknown>, ctx?: ToolContext) => void;
  onDone?: (args: Record<string, unknown>) => void;
  throwWith?: string;
  content?: ContentPart[];
  details?: unknown;
  terminate?: boolean;
  usage?: Usage;
}

function localTestTool(name: string, opts: LocalToolOpts = {}): AgentTool<Record<string, unknown>, unknown> {
  return {
    name,
    description: `local test tool ${name}`,
    schema: z.record(z.string(), z.unknown()),
    executionMode: opts.executionMode,
    risk: opts.risk,
    requiresContext: opts.requiresContext,
    async execute(args, ctx) {
      opts.onExecute?.(args as Record<string, unknown>, ctx);
      if (opts.untilAborted) {
        const signal = ctx?.signal;
        if (signal && !signal.aborted) {
          await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
        }
      }
      if (opts.durationMs !== undefined) await delay(opts.durationMs);
      if (opts.throwWith !== undefined) throw new Error(opts.throwWith);
      opts.onDone?.(args as Record<string, unknown>);
      return {
        status: opts.status ?? "ok",
        content: opts.content ?? [{ type: "text", text: `${name} done` }],
        details: opts.details ?? null,
        terminate: opts.terminate,
        usage: opts.usage,
      };
    },
  };
}

function fakeCtx(signal: AbortSignal): ToolContext {
  const fail = async () => ({ ok: false as const, error: { code: "IO" as const, message: "not available in unit tests" } });
  return {
    fs: { read: fail, readBytes: fail, write: fail, rename: fail, remove: fail, mkdir: fail, list: fail, stat: fail, tempDir: fail, grep: fail } as ToolContext["fs"],
    exec: fail,
    signal,
    cwd: "/workspace",
  };
}

const autoDecide: Decide = async request =>
  request.kind === "approval" ? { kind: "approval", decision: "allow" } : { kind: "question", answers: [] };

interface SetupOpts {
  tools?: AgentTool[];
  chat?: boolean;                    // true = 不注入 ctx（Chat 模式）
  decide?: Decide;
  hooks?: AgentHooks;
  approvalPolicy?: ApprovalPolicy;
  maxTurns?: number;
  toolConcurrency?: number;
  contextWindow?: number;
  sessionId?: string;
  storage?: SessionStorage;
}

function setup(stream: StreamFn, opts: SetupOpts = {}) {
  const storage = opts.storage ?? memoryStorage();
  const agent = createAgent({
    model: { provider: "gateway", model: "test-model", contextWindow: opts.contextWindow },
    stream,
    tools: opts.tools ?? [],
    storage,
    decide: opts.decide ?? autoDecide,
    ctx: opts.chat ? undefined : fakeCtx(new AbortController().signal),
    hooks: opts.hooks,
    approvalPolicy: opts.approvalPolicy,
    maxTurns: opts.maxTurns,
    toolConcurrency: opts.toolConcurrency,
    sessionId: opts.sessionId,
  });
  return { agent, storage };
}

function recordEvents(agent: ReturnType<typeof setup>["agent"]): AgentEvent[] {
  const events: AgentEvent[] = [];
  agent.subscribe(event => events.push(event));
  return events;
}

function textOf(blocks: Block[]): string {
  return blocks
    .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function toolResultBlocks(entries: Awaited<ReturnType<SessionStorage["loadEntries"]>>): Array<Extract<Block, { type: "tool_result" }> & { role: string }> {
  const results: Array<Extract<Block, { type: "tool_result" }> & { role: string }> = [];
  for (const item of entries) {
    if (item.kind !== "message") continue;
    for (const block of item.message.blocks) {
      if (block.type === "tool_result") results.push({ ...block, role: item.message.role });
    }
  }
  return results;
}

// —— 装配（§1.1）——

describe("装配校验（§1.1）", () => {
  it("Chat 模式接受自带执行环境的只读工具并能完成一次对话", async () => {
    const empty = scripted([]).stream;
    expect(() => setup(empty, { chat: true, tools: [localTestTool("writer", { risk: "write" })] })).toThrow(/Chat 模式/);
    expect(() => setup(empty, { chat: true, tools: [localTestTool("danger")] })).toThrow(/danger/);

    const { stream } = scripted([textEvents("hi")]);
    const { agent } = setup(stream, { chat: true, tools: [
      localTestTool("echo", { risk: "none" }),
      localTestTool("remote_read", { risk: "read", requiresContext: false }),
    ] });
    const result = await agent.prompt("hello");
    expect(result.stopReason).toBe("done");
    expect(textOf(result.message!.blocks)).toBe("hi");
  });
});

describe("结构化任务结果", () => {
  it("submit_result 终止 run 并通过 RunResult.output 返回成功结果", async () => {
    const output = { ok: true as const, summary: "implemented", data: { files: 2 } };
    const { stream, requests } = scripted([toolEvents([{ name: "submit_result", args: output }]), textEvents("unused")]);
    const { agent } = setup(stream, { chat: true });

    const result = await agent.prompt("do the task");

    expect(result.stopReason).toBe("terminate");
    expect(result.output).toEqual(output);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.tools.find(tool => tool.name === "submit_result")?.parameters).toMatchObject({
      type: "object",
      anyOf: [{ type: "object" }, { type: "object" }],
    });
  });

  it("submit_result 透传结构化失败，运行本身仍正常终止", async () => {
    const output = { ok: false as const, summary: "blocked", error: { code: "missing_input", message: "input is missing", retryable: false } };
    const { stream } = scripted([toolEvents([{ name: "submit_result", args: output }])]);
    const { agent } = setup(stream, { chat: true });

    const result = await agent.prompt("do the task");

    expect(result.stopReason).toBe("terminate");
    expect(result.output).toEqual(output);
  });
});

// —— 主流程（§4.1）——

describe("主流程", () => {
  it("无工具单 turn：Record 序列完整，usage 记账", async () => {
    const { stream, requests } = scripted([textEvents("done", { input: 10, output: 5 })]);
    const { agent, storage } = setup(stream);
    const events = recordEvents(agent);
    const result = await agent.prompt("hello");

    expect(result.stopReason).toBe("done");
    expect(result.usage).toEqual({ input: 10, output: 5 });
    expect(textOf(result.message!.blocks)).toBe("done");

    const records = await storage.loadRecords(agent.sessionId);
    expect(records.map(item => item.kind)).toEqual(["run-started", "turn-started", "usage", "run-finished"]);

    const entries = await storage.loadEntries(agent.sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.kind).toBe("message");
    expect(entries[1]!.kind).toBe("message");

    expect(requests[0]!.messages).toHaveLength(1);
    expect(requests[0]!.system).toContain("local");   // userId 缺省进入 system prompt
    expect(events.some(event => event.type === "run.end" && event.stopReason === "done")).toBe(true);
  });

  it("tool throw → error tool_result 喂回模型，run 继续", async () => {
    const { stream } = scripted([toolEvents([{ name: "boom", callId: "c1" }]), textEvents("recovered")]);
const { agent, storage } = setup(stream, { tools: [localTestTool("boom", { risk: "read", throwWith: "kaboom" })] });
    const result = await agent.prompt("go");

    expect(result.stopReason).toBe("done");
    expect(textOf(result.message!.blocks)).toBe("recovered");
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
    expect(textOf(results[0]!.content)).toContain("kaboom");

    const finished = (await storage.loadRecords(agent.sessionId)).find(item => item.kind === "tool-finished");
    expect(finished && finished.kind === "tool-finished" && finished.status).toBe("error");
  });

  it("rejects invalid tool arguments before approval or execution", async () => {
    const { stream } = scripted([toolEvents([{ name: "typed", args: {} }]), textEvents("recovered")]);
    let executed = false;
    const tool: AgentTool<{ path: string }> = {
      name: "typed",
      description: "typed tool",
      schema: z.object({ path: z.string() }),
      risk: "write",
      async execute() {
        executed = true;
        return { status: "ok", content: [{ type: "text", text: "unexpected" }], details: null };
      },
    };
    const { agent, storage } = setup(stream, { tools: [tool] });
    await agent.prompt("go");
    expect(executed).toBe(false);
    expect(textOf(toolResultBlocks(await storage.loadEntries(agent.sessionId))[0]!.content)).toContain("invalid arguments");
    expect((await storage.loadRecords(agent.sessionId)).some(record => record.kind === "tool-started")).toBe(false);
  });

  it("tool 显式 error status 贯穿 Block、Record 与事件", async () => {
    const { stream } = scripted([toolEvents([{ name: "failed" }]), textEvents("recovered")]);
const { agent, storage } = setup(stream, { tools: [localTestTool("failed", { risk: "read", status: "error", details: { reason: "nope" } })] });
    const events = recordEvents(agent);
    await agent.prompt("go");
    expect(toolResultBlocks(await storage.loadEntries(agent.sessionId))[0]!.status).toBe("error");
    expect((await storage.loadRecords(agent.sessionId)).some(record => record.kind === "tool-finished" && record.status === "error")).toBe(true);
    expect(events.some(event => event.type === "tool.end" && event.status === "error")).toBe(true);
  });

  it("未知工具 → 合成 error 结果，模型可见", async () => {
    const { stream } = scripted([toolEvents([{ name: "ghost" }]), textEvents("ok")]);
    const { agent, storage } = setup(stream);
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(textOf(results[0]!.content)).toContain("unknown tool: ghost");
    expect((await storage.loadRecords(agent.sessionId)).some(record => record.kind === "tool-started")).toBe(false);
  });

  it("max_tokens 与正常 stop 使用不同停止原因", async () => {
    const { stream } = scripted([[
      { type: "block.start", index: 0, blockType: "text" },
      { type: "block.end", index: 0, block: { type: "text", text: "truncated" } },
      { type: "finish", stopReason: "max_tokens" },
    ]]);
    const { agent } = setup(stream);
    expect((await agent.prompt("go")).stopReason).toBe("max_tokens");
  });

  it("typed context overflow 压缩后重试，普通错误不触发压缩", async () => {
    let mainTurn = 0;
    const stream: StreamFn = async function* (request) {
      if (request.tools.length === 0 && request.system.includes("压缩")) {
        yield { type: "block.end", index: 0, block: { type: "text", text: "summary" } };
        yield { type: "finish", stopReason: "stop" };
        return;
      }
      mainTurn += 1;
      if (mainTurn === 2) {
        yield { type: "finish", stopReason: "error", errorMessage: "too long", errorCode: "context_overflow" };
        return;
      }
      yield* textEvents(mainTurn === 1 ? "first" : "recovered");
    };
    const { agent, storage } = setup(stream);
    await agent.prompt("one");
    const result = await agent.prompt("two");
    expect(result.stopReason).toBe("done");
    expect(textOf(result.message!.blocks)).toBe("recovered");
    expect((await storage.loadEntries(agent.sessionId)).some(item => item.kind === "compaction")).toBe(true);
  });

  it("同步 listener 异常不影响其它 listener 或 Loop", async () => {
    const { stream } = scripted([textEvents("done")]);
    const { agent } = setup(stream);
    const seen: string[] = [];
    agent.subscribe(() => { throw new Error("observer failed"); });
    agent.subscribe(event => { seen.push(event.type); });
    expect((await agent.prompt("go")).stopReason).toBe("done");
    expect(seen).toContain("run.end");
  });

  it("stream finish error → stopReason error，state.errorMessage 与 error 事件", async () => {
    const { stream } = scripted([[{ type: "finish", stopReason: "error", errorMessage: "provider 500" }]]);
    const { agent, storage } = setup(stream);
    const events = recordEvents(agent);
    const result = await agent.prompt("go");

    expect(result.stopReason).toBe("error");
    expect(agent.state.errorMessage).toBe("provider 500");
    expect(events.some(event => event.type === "error" && event.message === "provider 500")).toBe(true);
    const finished = (await storage.loadRecords(agent.sessionId)).find(item => item.kind === "run-finished");
    expect(finished && finished.kind === "run-finished" && finished.stopReason).toBe("error");
  });

  it("maxTurns 耗尽 → stopReason max_turns", async () => {
    const { stream, requests } = scripted([
      toolEvents([{ name: "ping" }]),
      toolEvents([{ name: "ping" }]),
      textEvents("never reached"),
    ]);
const { agent } = setup(stream, { tools: [localTestTool("ping", { risk: "read" })], maxTurns: 2 });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("max_turns");
    expect(requests).toHaveLength(2);
  });
});

// —— Tool batch（§4.2）——

describe("tool batch", () => {
  it("20 个 call 并发上限 8：在途不超过 8，结果按原始顺序回填", async () => {
    let inFlight = 0;
    let maxSeen = 0;
const tool = localTestTool("work", {
      risk: "read",
      durationMs: 25,
      onExecute: () => { inFlight += 1; maxSeen = Math.max(maxSeen, inFlight); },
      onDone: () => { inFlight -= 1; },
    });
    const calls = Array.from({ length: 20 }, (_, index) => ({ name: "work", callId: `w-${index}` }));
    const { stream } = scripted([toolEvents(calls), textEvents("done")]);
    const { agent, storage } = setup(stream, { tools: [tool] });

    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(maxSeen).toBeLessThanOrEqual(8);
    expect(maxSeen).toBeGreaterThanOrEqual(2);

    // 顺序回填：tool_result 块顺序 = 原始 call 顺序
    const entries = await storage.loadEntries(agent.sessionId);
    const resultMessage = entries.find(item => item.kind === "message" && item.message.role === "user" && item.message.blocks.some(block => block.type === "tool_result"));
    expect(resultMessage && resultMessage.kind === "message").toBe(true);
    if (resultMessage && resultMessage.kind === "message") {
      const ids = resultMessage.message.blocks
        .filter((block): block is Extract<Block, { type: "tool_result" }> => block.type === "tool_result")
        .map(block => block.callId);
      expect(ids).toEqual(calls.map(call => call.callId));
    }
  });

  it("sequential tool 独占执行：不与其他 task 重叠", async () => {
    let inFlight = 0;
    let seqMaxSeen = 0;
const seq = localTestTool("seq", {
      executionMode: "sequential",
      risk: "exec",
      durationMs: 15,
      onExecute: () => { inFlight += 1; seqMaxSeen = Math.max(seqMaxSeen, inFlight); },
      onDone: () => { inFlight -= 1; },
    });
const par = localTestTool("par", {
      risk: "read",
      durationMs: 15,
      onExecute: () => { inFlight += 1; },
      onDone: () => { inFlight -= 1; },
    });
    const { stream } = scripted([
      toolEvents([{ name: "par", callId: "p1" }, { name: "seq", callId: "s1" }, { name: "seq", callId: "s2" }, { name: "par", callId: "p2" }]),
      textEvents("done"),
    ]);
    const { agent } = setup(stream, { tools: [seq, par] });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(seqMaxSeen).toBe(1);
  });

  it("risk write 按路径串行：同路径不并发，不同路径可并行", async () => {
    const runningByPath = new Map<string, number>();
    let samePathOverlap = false;
    let inFlight = 0;
    let maxSeen = 0;
const writer = localTestTool("write_file", {
      risk: "write",
      durationMs: 15,
      onExecute: args => {
        const path = args.path as string;
        const now = (runningByPath.get(path) ?? 0) + 1;
        runningByPath.set(path, now);
        if (now > 1) samePathOverlap = true;
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
      },
      onDone: args => {
        const path = args.path as string;
        runningByPath.set(path, (runningByPath.get(path) ?? 0) - 1);
        inFlight -= 1;
      },
    });
    const { stream } = scripted([
      toolEvents([
        { name: "write_file", args: { path: "a.txt" }, callId: "a1" },
        { name: "write_file", args: { path: "b.txt" }, callId: "b1" },
        { name: "write_file", args: { path: "a.txt" }, callId: "a2" },
        { name: "write_file", args: { path: "b.txt" }, callId: "b2" },
      ]),
      textEvents("done"),
    ]);
    const { agent } = setup(stream, { tools: [writer] });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(samePathOverlap).toBe(false);
    expect(maxSeen).toBeGreaterThanOrEqual(2);
  });

  it("terminate：全部结果置 terminate 才提前结束", async () => {
    const all = scripted([toolEvents([{ name: "stop1" }, { name: "stop2" }]), textEvents("never")]);
    const agent1 = setup(all.stream, {
tools: [localTestTool("stop1", { risk: "read", terminate: true }), localTestTool("stop2", { risk: "read", terminate: true })],
    }).agent;
    const result1 = await agent1.prompt("go");
    expect(result1.stopReason).toBe("terminate");
    expect(all.requests).toHaveLength(1);

    const partial = scripted([toolEvents([{ name: "stop1" }, { name: "plain" }]), textEvents("continued")]);
    const agent2 = setup(partial.stream, {
tools: [localTestTool("stop1", { risk: "read", terminate: true }), localTestTool("plain", { risk: "read" })],
    }).agent;
    const result2 = await agent2.prompt("go");
    expect(result2.stopReason).toBe("done");
    expect(partial.requests).toHaveLength(2);
  });

  it("abort 中段：未启动的 call 收敛为 error 结果，每个 tool_call 都有 tool_result", async () => {
    let hangStarted = false;
const hang = localTestTool("hang", {
      executionMode: "sequential",
      risk: "read",
      untilAborted: true,
      onExecute: () => { hangStarted = true; },
    });
const quick = localTestTool("quick", { risk: "read", durationMs: 5 });
    const { stream } = scripted([
      toolEvents([{ name: "hang", callId: "h1" }, { name: "quick", callId: "q1" }]),
      textEvents("never"),
    ]);
    const { agent, storage } = setup(stream, { tools: [hang, quick] });
    const events = recordEvents(agent);

    const runPromise = agent.prompt("go");
    await waitFor(() => hangStarted);
    await agent.abort();
    const result = await runPromise;

    expect(result.stopReason).toBe("aborted");
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(results).toHaveLength(2);
    expect(textOf(results[1]!.content)).toContain("was not executed");

    const records = await storage.loadRecords(agent.sessionId);
    const started = records.filter(item => item.kind === "tool-started");
    expect(started).toHaveLength(1);                       // quick 从未启动
    expect(records.some(item => item.kind === "abort-requested")).toBe(true);
    expect(events.some(event => event.type === "run.end" && event.stopReason === "aborted")).toBe(true);
  });
});

// —— 队列（§7）——

describe("队列", () => {
  it("steering 在 tool batch 完成后（排空点 A）注入当前 run", async () => {
    const { stream, requests } = scripted([toolEvents([{ name: "slow" }]), textEvents("after steer")]);
const { agent, storage } = setup(stream, { tools: [localTestTool("slow", { risk: "read", durationMs: 40 })] });

    const runPromise = agent.prompt("go");
    agent.steer("change direction");
    const result = await runPromise;

    expect(result.stopReason).toBe("done");
    const entries = await storage.loadEntries(agent.sessionId);
    // 顺序：… → user tool_result → user steering（排空点 A 在 batch 之后）→ assistant 回答
    const steerIndex = entries.findIndex(item => item.kind === "message" && textOf(item.message.blocks) === "change direction");
    const toolResultIndex = entries.findIndex(item => item.kind === "message" && item.message.blocks.some(block => block.type === "tool_result"));
    const finalIndex = entries.findIndex(item => item.kind === "message" && textOf(item.message.blocks) === "after steer");
    expect(toolResultIndex).toBeLessThan(steerIndex);
    expect(steerIndex).toBeLessThan(finalIndex);

    // 第二个 turn 的请求里模型看得见 steering
    expect(requests[1]!.messages.some(message => textOf(message.blocks).includes("change direction"))).toBe(true);

    const records = await storage.loadRecords(agent.sessionId);
    expect(records.some(item => item.kind === "queue-enqueued" && item.queue === "steering" && item.message === "change direction")).toBe(true);
  });

  it("followUp 在模型不再要工具时（排空点 B）注入并续跑", async () => {
    const { stream, requests } = scripted([
      toolEvents([{ name: "fast" }]),
      textEvents("first answer"),
      textEvents("second answer"),
    ]);
const { agent, storage } = setup(stream, { tools: [localTestTool("fast", { risk: "read", durationMs: 10 })] });

    const runPromise = agent.prompt("go");
    agent.followUp("keep going");
    const result = await runPromise;

    expect(result.stopReason).toBe("done");
    expect(textOf(result.message!.blocks)).toBe("second answer");
    expect(requests).toHaveLength(3);

    const entries = await storage.loadEntries(agent.sessionId);
    const followIndex = entries.findIndex(item => item.kind === "message" && textOf(item.message.blocks) === "keep going");
    const firstAnswerIndex = entries.findIndex(item => item.kind === "message" && textOf(item.message.blocks) === "first answer");
    expect(firstAnswerIndex).toBeLessThan(followIndex);
    expect(followIndex).toBe(entries.length - 2);         // 紧跟最后一条回答之前
  });

  it("nextRun 在当前 run 结束后触发一个独立 run", async () => {
    const { stream, requests } = scripted([textEvents("first run"), textEvents("second run")]);
    const { agent, storage } = setup(stream);

    agent.nextRun("second task");
    const result1 = await agent.prompt("first task");
    expect(result1.stopReason).toBe("done");

    await waitFor(() => requests.length === 2);
    const records = await storage.loadRecords(agent.sessionId);
    const runStarted = records.filter((item): item is Extract<SessionRecord, { kind: "run-started" }> => item.kind === "run-started");
    expect(runStarted).toHaveLength(2);
    expect(runStarted[1]!.input).toBe("second task");
    expect(records.filter(item => item.kind === "run-finished")).toHaveLength(2);
  });
});

// —— TODO（§9）——

const todoList = (statuses: Array<"pending" | "in_progress" | "completed" | "blocked">) =>
  statuses.map((status, index) => ({ id: `todo-${index}`, text: `todo ${index}`, status }));

describe("TODO", () => {
  it("todo_write 成功 → TodoState 更新：todo-updated Record + todo.updated 事件", async () => {
    const items = todoList(["in_progress", "pending", "pending"]);
    const { stream } = scripted([
      toolEvents([{ name: "todo_write", args: { items } }]),
      textEvents("ok"),
    ]);
const { agent, storage } = setup(stream, { tools: [localTestTool("todo_write", { risk: "none", details: { items } })] });
    const events = recordEvents(agent);
    await agent.prompt("plan");

    const todoRecords = (await storage.loadRecords(agent.sessionId))
      .filter((item): item is Extract<SessionRecord, { kind: "todo-updated" }> => item.kind === "todo-updated");
    expect(todoRecords).toHaveLength(1);
    expect(todoRecords[0]!.items).toEqual(items);
    expect(events.some(event => event.type === "todo.updated")).toBe(true);
  });

  it("注入位置：最后一条 user 带 tool_result 时放在其后；否则紧邻其前", async () => {
    const items = todoList(["in_progress", "pending", "pending"]);
    const { stream, requests } = scripted([
      toolEvents([{ name: "todo_write", args: { items } }]),
      textEvents("done"),
      textEvents("more done"),
    ]);
const { agent } = setup(stream, { tools: [localTestTool("todo_write", { risk: "none", details: { items } })] });
    await agent.prompt("plan");
    await agent.prompt("more");

    // 同 run 内：tool_result 之后追加（不能隔开 tool_call / tool_result 配对）
    const midTurn = requests[1]!.messages;
    const note = midTurn[midTurn.length - 1]!;
    expect(textOf(note.blocks)).toContain("当前 TODO");
    expect(midTurn[midTurn.length - 2]!.blocks.some(block => block.type === "tool_result")).toBe(true);

    // 新 run 的首个请求：紧邻最后一条 user message 之前
    const resumed = requests[2]!.messages;
    const noteIndex = resumed.findIndex(message => textOf(message.blocks).includes("当前 TODO"));
    expect(noteIndex).toBe(resumed.length - 2);
    expect(resumed[resumed.length - 1]!.role).toBe("user");
    expect(textOf(resumed[noteIndex]!.blocks)).toContain("- [~] todo 0");
  });

  it("只有 1 项未完成 → 不注入", async () => {
    const items = todoList(["in_progress"]);
    const { stream, requests } = scripted([
      toolEvents([{ name: "todo_write", args: { items } }]),
      textEvents("done"),
      textEvents("more done"),
    ]);
const { agent } = setup(stream, { tools: [localTestTool("todo_write", { risk: "none", details: { items } })] });
    await agent.prompt("plan");
    await agent.prompt("more");
    const lastRequest = requests[2]!;
    expect(lastRequest.messages.every(message => !textOf(message.blocks).includes("TODO"))).toBe(true);
  });

  it("TodoState 不受压缩影响：manual compact 后注入仍在", async () => {
    const items = todoList(["in_progress", "pending", "pending"]);
    const { stream, requests } = scripted([
      toolEvents([{ name: "todo_write", args: { items } }]),
      textEvents("done"),
      // compact() 触发的摘要请求
      [{ type: "block.end", index: 0, block: { type: "text", text: "SUMMARY" } }, { type: "finish", stopReason: "stop" }],
      textEvents("more done"),
    ]);
const { agent, storage } = setup(stream, { tools: [localTestTool("todo_write", { risk: "none", details: { items } })] });
    await agent.prompt("plan");

    const compacted = await agent.compact();
    expect(compacted.summarized).toBe(true);
    expect((await storage.loadEntries(agent.sessionId)).some(item => item.kind === "compaction")).toBe(true);

    await agent.prompt("more");
    const afterCompact = requests[3]!.messages;
    expect(afterCompact.some(message => textOf(message.blocks).includes("当前 TODO"))).toBe(true);
    expect(afterCompact.some(message => textOf(message.blocks).includes("SUMMARY"))).toBe(true);
  });
});

// —— 预算与压缩（§8）——

describe("上下文预算与压缩", () => {
  it("usage 超过 contextWindow * 0.8 → 下一 turn 前先压缩，摘要进入后续请求", async () => {
    const turns: ModelEvent[][] = [
      toolEvents([{ name: "ping" }], { input: 100, output: 1 }),
      toolEvents([{ name: "ping" }], { input: 900, output: 1 }),
      textEvents("finished"),
    ];
    const calls: ModelRequest[] = [];
    let turn = 0;
    const stream: StreamFn = async function* (request) {
      calls.push(request);
      if (request.tools.length === 0 && request.system.includes("压缩")) {
        yield { type: "block.end", index: 0, block: { type: "text", text: "THE-SUMMARY" } };
        yield { type: "finish", stopReason: "stop" };
        return;
      }
      for (const event of turns[turn++] ?? []) yield event;
    };
    const { agent, storage } = setup(stream, {
tools: [localTestTool("ping", { risk: "read" })],
      contextWindow: 1000,
    });
    const result = await agent.prompt("go");

    expect(result.stopReason).toBe("done");
    // 调用顺序：turn0 → turn1 → 摘要 → turn2
    expect(calls).toHaveLength(4);
    expect(calls[2]!.tools).toHaveLength(0);
    expect(calls[2]!.system).toContain("压缩");

    const after = calls[3]!.messages;
    expect(textOf(after[0]!.blocks)).toContain("THE-SUMMARY");
    expect(textOf(after[0]!.blocks)).toContain("[以下是早前对话的摘要]");
    expect(after.every(message => !textOf(message.blocks).includes("go"))).toBe(true);

    expect((await storage.loadEntries(agent.sessionId)).some(item => item.kind === "compaction")).toBe(true);
  });
});

// —— Decision（§6）——

describe("decision", () => {
  it("risk write 缺省 ask：decide 收到 approval 请求，allow 后执行", async () => {
    const seen: DecisionResponse[] = [];
    const decide: Decide = async request => {
      expect(request.kind).toBe("approval");
      seen.push({ kind: "approval", decision: "allow" });
      return { kind: "approval", decision: "allow" };
    };
    let executed = false;
    const { stream } = scripted([toolEvents([{ name: "deploy" }]), textEvents("ok")]);
    const { agent, storage } = setup(stream, {
tools: [localTestTool("deploy", { risk: "write", onExecute: () => { executed = true; } })],
      decide,
    });
    const events = recordEvents(agent);
    const result = await agent.prompt("go");

    expect(result.stopReason).toBe("done");
    expect(executed).toBe(true);
    expect(seen).toHaveLength(1);
    expect(events.some(event => event.type === "decision.requested" && event.request.kind === "approval")).toBe(true);
    expect(agent.state.pendingDecision).toBeNull();

    const records = await storage.loadRecords(agent.sessionId);
    expect(records.some(item => item.kind === "decision-requested")).toBe(true);
    const resolved = records.find((item): item is Extract<SessionRecord, { kind: "decision-resolved" }> => item.kind === "decision-resolved");
    expect(resolved?.response).toEqual({ kind: "approval", decision: "allow" });
  });

  it("deny 必须到达模型：error tool_result 且工具未执行", async () => {
    let executed = false;
    const { stream } = scripted([toolEvents([{ name: "deploy" }]), textEvents("understood")]);
    const { agent, storage } = setup(stream, {
tools: [localTestTool("deploy", { risk: "write", onExecute: () => { executed = true; } })],
      decide: async () => ({ kind: "approval", decision: "deny" }),
    });
    const result = await agent.prompt("go");

    expect(result.stopReason).toBe("done");
    expect(executed).toBe(false);
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(results[0]!.status).toBe("error");
    expect(textOf(results[0]!.content)).toContain("denied by user: deploy");
    expect((await storage.loadRecords(agent.sessionId)).some(record => record.kind === "tool-started")).toBe(false);
  });

  it("allow_always 写入 session allowlist：同名后续调用不再询问", async () => {
    let decideCount = 0;
    const { stream } = scripted([
      toolEvents([{ name: "deploy", callId: "x1" }]),
      toolEvents([{ name: "deploy", callId: "x2" }]),
      textEvents("ok"),
    ]);
    const { agent } = setup(stream, {
tools: [localTestTool("deploy", { risk: "write" })],
      decide: async () => { decideCount += 1; return { kind: "approval", decision: "allow_always" }; },
    });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(decideCount).toBe(1);
  });

  it("timeout fail-closed：人类不回答按拒绝处理（requestDecision 单元）", async () => {
    const storage = memoryStorage();
    const events: AgentEvent[] = [];
    const outcome = await requestDecision(
      { kind: "question", decisionId: "d-t", question: "q", options: [], multiSelect: false },
      {
        decide: () => new Promise<DecisionResponse>(() => { /* 永不回答 */ }),
        sessionId: "s-decision",
        storage,
        runId: () => "run-x",
        emit: event => events.push(event),
        timeoutMs: 30,
      },
      new AbortController().signal,
    );
    expect(outcome).toBe("timeout");
    const records = await storage.loadRecords("s-decision");
    const resolved = records.find((item): item is Extract<SessionRecord, { kind: "decision-resolved" }> => item.kind === "decision-resolved");
    expect(resolved?.response).toBe("timeout");
    expect(events.some(event => event.type === "decision.resolved")).toBe(true);
  });

  it("abort 打断等待中的 decision → run aborted，decision 收敛", async () => {
    const { stream } = scripted([toolEvents([{ name: "risky" }]), textEvents("never")]);
    const { agent, storage } = setup(stream, {
tools: [localTestTool("risky", { risk: "write" })],
      decide: () => new Promise<DecisionResponse>(() => { /* 永不回答 */ }),
    });

    const runPromise = agent.prompt("go");
    await waitFor(() => agent.state.pendingDecision !== null);
    await agent.abort();
    const result = await runPromise;

    expect(result.stopReason).toBe("aborted");
    expect(agent.state.pendingDecision).toBeNull();
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(textOf(results[0]!.content)).toContain("was not executed");
    const resolved = (await storage.loadRecords(agent.sessionId))
      .find((item): item is Extract<SessionRecord, { kind: "decision-resolved" }> => item.kind === "decision-resolved");
    expect(resolved?.response).toBe("timeout");          // abort 收敛按 fail-closed 记录
  });

  it("ask_user 反问：question decision 往返，答案进入 tool_result", async () => {
    const seen: string[] = [];
    const { stream } = scripted([
      toolEvents([{ name: "ask_user", args: { question: "pick one", options: ["alpha", "beta"] } }]),
      textEvents("thanks"),
    ]);
    const { agent, storage } = setup(stream, {
      decide: async request => {
        if (request.kind !== "question") return { kind: "approval", decision: "deny" };
        seen.push(request.question);
        return { kind: "question", answers: ["alpha"] };
      },
    });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(seen).toEqual(["pick one"]);
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(textOf(results[0]!.content)).toBe("- alpha");
  });
});

// —— Hooks（§4.3）——

describe("hooks", () => {
  it("beforeToolCall allow 不能放宽基础 ask", async () => {
    let decideCount = 0;
    let executed = false;
    const { stream } = scripted([toolEvents([{ name: "deploy" }]), textEvents("ok")]);
    const { agent } = setup(stream, {
tools: [localTestTool("deploy", { risk: "write", onExecute: () => { executed = true; } })],
      decide: async () => { decideCount += 1; return { kind: "approval", decision: "allow" }; },
      hooks: { beforeToolCall: async () => "allow" as const },
    });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(executed).toBe(true);
    expect(decideCount).toBe(1);
  });

  it("beforeToolCall deny → 工具不执行且不询问", async () => {
    let decideCount = 0;
    let executed = false;
    const { stream } = scripted([toolEvents([{ name: "writer" }]), textEvents("ok")]);
    const { agent, storage } = setup(stream, {
tools: [localTestTool("writer", { risk: "write", onExecute: () => { executed = true; } })],
      decide: async () => { decideCount += 1; return { kind: "approval", decision: "allow" }; },
      hooks: { beforeToolCall: async () => "deny" as const },
    });
    await agent.prompt("go");
    expect(executed).toBe(false);
    expect(decideCount).toBe(0);
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(textOf(results[0]!.content)).toContain("denied by user");
  });

  it("beforeToolCall ask → 把 auto 升级为 ask", async () => {
    let decideCount = 0;
    const { stream } = scripted([toolEvents([{ name: "reader" }]), textEvents("ok")]);
    const { agent } = setup(stream, {
tools: [localTestTool("reader", { risk: "read" })],
      approvalPolicy: { default: "auto" },
      decide: async () => { decideCount += 1; return { kind: "approval", decision: "allow" }; },
      hooks: { beforeToolCall: async () => "ask" as const },
    });
    await agent.prompt("go");
    expect(decideCount).toBe(1);
  });

  it("prepareNextTurn 变更 model/thinking/activeTools → 落 Entry 且下一请求生效", async () => {
    let prepared = 0;
    const { stream, requests } = scripted([
      toolEvents([{ name: "fast" }]),
      toolEvents([{ name: "fast" }]),
      textEvents("end"),
    ]);
    const { agent, storage } = setup(stream, {
tools: [localTestTool("fast", { risk: "read" })],
      hooks: {
        prepareNextTurn: () => {
          prepared += 1;
          if (prepared === 1) return { model: "m2", thinkingLevel: "high", activeTools: ["fast"] };
          return undefined;
        },
      },
    });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");

    expect(requests[1]!.thinking).toBe("high");
    expect(requests[1]!.tools.map(tool => tool.name)).toEqual(["fast"]);
    expect(agent.state.model).toBe("m2");
    expect(agent.state.thinkingLevel).toBe("high");

    const entries = await storage.loadEntries(agent.sessionId);
    expect(entries.some(item => item.kind === "model" && item.model === "m2")).toBe(true);
    expect(entries.some(item => item.kind === "thinking-level" && item.level === "high")).toBe(true);
    expect(entries.some(item => item.kind === "active-tools" && item.tools.includes("fast"))).toBe(true);

    const records = await storage.loadRecords(agent.sessionId);
    const turn1 = records.find((item): item is Extract<SessionRecord, { kind: "turn-started" }> => item.kind === "turn-started" && item.turn === 1);
    expect(turn1?.model).toBe("m2");
  });

  it("shouldStopAfterTurn → 提前结束且 stopReason done", async () => {
    const { stream, requests } = scripted([toolEvents([{ name: "fast" }]), textEvents("unused")]);
    const { agent } = setup(stream, {
tools: [localTestTool("fast", { risk: "read" })],
      hooks: { shouldStopAfterTurn: () => true },
    });
    const result = await agent.prompt("go");
    expect(result.stopReason).toBe("done");
    expect(requests).toHaveLength(1);
  });

  it("afterToolCall 只在实际执行的调用上触发", async () => {
    const seen: ToolCall[] = [];
    const { stream } = scripted([toolEvents([{ name: "good" }, { name: "ghost" }]), textEvents("ok")]);
    const { agent } = setup(stream, {
tools: [localTestTool("good", { risk: "read" })],
      hooks: { afterToolCall: call => { seen.push(call); } },
    });
    await agent.prompt("go");
    expect(seen.map(call => call.name)).toEqual(["good"]);
  });
});

// —— Sub-agent（§10）——

describe("sub-agent", () => {
  it("spawn_agent：子 agent 独立 session，文本摘要/转录/usage 回到父，工具集受 depth 与参数约束", async () => {
    const parentTurns: ModelEvent[][] = [
      toolEvents([{ name: "spawn_agent", args: { task: "child task", tools: ["keeper"] }, callId: "spawn-1" }]),
      textEvents("parent done"),
    ];
    const requests: ModelRequest[] = [];
    let parentTurn = 0;
    const stream: StreamFn = async function* (request) {
      requests.push(request);
      const lastUser = [...request.messages].reverse().find(message => message.role === "user");
      const text = lastUser ? textOf(lastUser.blocks) : "";
      if (text.includes("child task")) {
        for (const event of textEvents("CHILD-OK", { input: 3, output: 4 })) yield event;
        return;
      }
      for (const event of parentTurns[parentTurn++] ?? []) yield event;
    };
    const { agent, storage } = setup(stream, {
tools: [localTestTool("keeper", { risk: "read" }), localTestTool("excluded", { risk: "read" })],
    });
    const events = recordEvents(agent);
    const result = await agent.prompt("delegate");

    expect(result.stopReason).toBe("done");
    // 子 agent usage 记父账（§10）
    expect(result.usage.input).toBe(3);
    expect(result.usage.output).toBe(4);

    // tool_result = 子 agent 的最终文本；tool.end details 携带完整转录
    const results = toolResultBlocks(await storage.loadEntries(agent.sessionId));
    expect(textOf(results[0]!.content)).toBe("CHILD-OK");
    const spawnEnd = events.find((event): event is Extract<AgentEvent, { type: "tool.end" }> => event.type === "tool.end" && event.callId === "spawn-1");
    expect(spawnEnd).toBeDefined();
    expect((spawnEnd!.details as { transcript: unknown[] }).transcript).toHaveLength(2);

    // 子 agent 的请求：工具子集 = 参数指定 + ask_user；depth 封顶不再有 spawn_agent
    const childRequest = requests.find(request => request.messages.some(message => textOf(message.blocks).includes("child task")));
    expect(childRequest).toBeDefined();
    expect(childRequest!.tools.map(tool => tool.name)).toEqual(["keeper", "submit_result", "ask_user"]);
  });

  it("共享并发闸门：maxConcurrent 限制在途子任务，排空后可复用", async () => {
    const gate1 = createSubAgentGate(1);
    let inFlight = 0;
    let maxSeen = 0;
    const work = () => gate1.run(async () => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await delay(20);
      inFlight -= 1;
      return "v";
    });
    const values = await Promise.all([work(), work(), work()]);
    expect(values).toEqual(["v", "v", "v"]);
    expect(maxSeen).toBe(1);

    // 闸门排空后重建 flow，继续可用
    await delay(10);
    expect(await gate1.run(async () => 42)).toBe(42);

    const gate2 = createSubAgentGate(2);
    inFlight = 0;
    maxSeen = 0;
    const work2 = () => gate2.run(async () => {
      inFlight += 1;
      maxSeen = Math.max(maxSeen, inFlight);
      await delay(20);
      inFlight -= 1;
    });
    await Promise.all([work2(), work2(), work2()]);
    expect(maxSeen).toBe(2);
  });
});

// —— fork / resume（§5）——

describe("fork 与 resume", () => {
  it("fork：新分支独立生长，原分支不受影响", async () => {
    const { stream: stream1 } = scripted([textEvents("A")]);
    const { agent, storage } = setup(stream1);
    await agent.prompt("one");

    const branch = await storage.loadEntries(agent.sessionId);
    const parentLeaf = branch[branch.length - 1]!.id;
    const forked = await agent.fork(branch[0]!.id);

    // 让 forked agent 用不同的 stream：重新 setup 不行（createAgent 已绑定），
    // 这里 forked 与原 agent 共享 config.stream（scripted 已耗尽 → 空回答），
    // 用新的 storage 视角验证分支结构即可。
    await forked.prompt("two");

    const forkBranch = await storage.loadEntries(agent.sessionId);            // lastLeaf 现在是 fork 的叶
    expect(forkBranch.some(item => item.kind === "message" && textOf(item.message.blocks) === "two")).toBe(true);
    expect(forkBranch.some(item => item.kind === "message" && textOf(item.message.blocks) === "A")).toBe(false);

    const parentBranch = await storage.loadEntries(agent.sessionId, parentLeaf);
    expect(parentBranch).toHaveLength(2);
    expect(textOf((parentBranch[1] as Extract<typeof parentBranch[number], { kind: "message" }>).message.blocks)).toBe("A");
    await expect(agent.fork("no-such-entry")).rejects.toThrow(/entry not found/);
  });

  // 构造一个"进程死在 tool 执行中"的 session：run-started + tool-started，没有 run-finished
  async function interruptedFixture(storage: SessionStorage, sessionId: string, opts: { decision?: boolean; todos?: boolean } = {}) {
    const user = entry({ kind: "message", message: { id: "m-1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "fix the bug" }] } });
    const assistant = entry({
      kind: "message",
      parentId: user.id,
      message: { id: "m-2", role: "assistant", createdAt: 2, blocks: [{ type: "tool_call", callId: "c1", name: "ping", args: {} }] },
    });
    await storage.appendEntry(sessionId, user);
    await storage.appendEntry(sessionId, assistant);
    await storage.appendRecord(sessionId, record("run-1", { kind: "run-started", input: "fix the bug" }));
    await storage.appendRecord(sessionId, record("run-1", { kind: "tool-started", callId: "c1", name: "ping", args: {} }));
    if (opts.decision) {
      await storage.appendRecord(sessionId, record("run-1", {
        kind: "decision-requested",
        decisionId: "d1",
        request: { kind: "approval", decisionId: "d1", callId: "c1", toolName: "ping", args: {}, risk: "write" },
      }));
    }
    if (opts.todos) {
      await storage.appendRecord(sessionId, record("run-1", { kind: "todo-updated", items: todoList(["in_progress", "pending", "pending"]) }));
    }
  }

  it("resume：中断的 tool 调用合成 error 结果喂回，然后续跑", async () => {
    const storage = memoryStorage();
    await interruptedFixture(storage, "s-resume");
    const { stream, requests } = scripted([textEvents("recovered")]);
    const { agent } = setup(stream, { storage, sessionId: "s-resume" });

    await agent.resume();

    const entries = await storage.loadEntries("s-resume");
    const synthetic = toolResultBlocks(entries);
    expect(synthetic).toHaveLength(1);
    expect(synthetic[0]!.status).toBe("error");
    expect(textOf(synthetic[0]!.content)).toContain("上次运行在此中断");

    const records = await storage.loadRecords("s-resume");
    expect(records.filter(item => item.kind === "run-started")).toHaveLength(2);
    expect(records.filter(item => item.kind === "run-finished")).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });

  it("resume：未决 decision 重新发给人类", async () => {
    const storage = memoryStorage();
    await interruptedFixture(storage, "s-resume-d", { decision: true });
    const seen: string[] = [];
    const { stream } = scripted([textEvents("recovered")]);
    const { agent } = setup(stream, {
      storage,
      sessionId: "s-resume-d",
      decide: async request => {
        seen.push(request.decisionId);
        return request.kind === "approval" ? { kind: "approval", decision: "allow" } : { kind: "question", answers: [] };
      },
    });

    await agent.resume();

    expect(seen).toEqual(["d1"]);
    const records = await storage.loadRecords("s-resume-d");
    const resolved = records.filter((item): item is Extract<SessionRecord, { kind: "decision-resolved" }> => item.kind === "decision-resolved");
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.decisionId).toBe("d1");
    expect(resolved[0]!.runId).toBe("run-1");
  });

  it("resume：TodoState 从 todo-updated Record 恢复并注入", async () => {
    const storage = memoryStorage();
    await interruptedFixture(storage, "s-resume-t", { todos: true });
    const { stream, requests } = scripted([textEvents("recovered")]);
    const { agent } = setup(stream, { storage, sessionId: "s-resume-t" });

    await agent.resume();

    expect(requests[0]!.messages.some(message => textOf(message.blocks).includes("当前 TODO"))).toBe(true);
  });

  it("resume：没有中断的 run → 无操作", async () => {
    const storage = memoryStorage();
    await storage.appendRecord("s-clean", record("run-1", { kind: "run-started", input: "x" }));
    await storage.appendRecord("s-clean", record("run-1", { kind: "run-finished", stopReason: "done" }));
    const { stream, requests } = scripted([]);
    const { agent } = setup(stream, { storage, sessionId: "s-clean" });

    await agent.resume();

    expect(requests).toHaveLength(0);
    expect((await storage.loadRecords("s-clean")).filter(item => item.kind === "run-started")).toHaveLength(1);
  });
});
