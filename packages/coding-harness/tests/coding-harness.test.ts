import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import test from "node:test";
import {
  agentExecutor,
  defineDynamicTool,
  modelRouter,
  sessionDefinition,
  toolDefinitions,
  type AgentEvent,
  type JsonValue,
  type ModelAdapter,
  type ModelChunk,
  type ModelStepRequest,
  type PluginDefinition,
  type RunResult,
  type SafeError,
  type SessionSnapshot,
  type ToolDefinition,
} from "@nnova/harness";
import { contextPlugin } from "@nnova/harness/plugins/context";
import { memorySessionPlugin } from "@nnova/harness/plugins/session-memory";
import { toolRuntimePlugin } from "@nnova/harness/plugins/tools";
import { summaryCompactionPlugin } from "@nnova/harness/plugins/compaction";
import type { FileSystem, Result, RunnerFailure, RunnerSession, ToolContextOptions } from "@nova/runner-sdk";
import { createCodingHarness, codingProfile, dashboardProfile, type CodingHarnessOptions } from "../src/index.js";

type Step = {
  check?: (request: ModelStepRequest) => void | Promise<void>;
} & ({ text: string } | { calls: readonly { name: string; input: JsonValue }[] });

class ScriptedModel implements ModelAdapter {
  readonly id = "scripted";
  readonly requests: ModelStepRequest[] = [];
  readonly updates: JsonValue[] = [];
  version = 1;
  disposed = 0;
  cleanup: (() => void | Promise<void>) | undefined;
  constructor(private readonly steps: readonly Step[]) {}
  readonly plugin: PluginDefinition = {
    manifest: {
      id: "test.model",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [modelRouter],
    },
    setup: (context) => {
      context.provide(modelRouter, this);
      context.onDispose(async () => {
        this.disposed++;
        await this.cleanup?.();
      });
    },
  };
  binding() {
    return { plugin: this.plugin, modelId: "scripted" };
  }
  snapshot() {
    return {
      id: "scripted",
      configVersion: this.version,
      contextWindow: 128_000,
      maxOutputTokens: 1_000,
      capabilities: { tools: true, images: true, files: true },
    };
  }
  update(configuration: JsonValue) {
    this.updates.push(configuration);
    this.version++;
  }
  async *stream(request: ModelStepRequest): AsyncIterable<ModelChunk> {
    const step = this.steps[this.requests.length];
    assert.ok(step, "The model must not be called beyond the scripted steps.");
    this.requests.push(request);
    await step.check?.(request);
    request.signal.throwIfAborted();
    if ("text" in step) {
      yield { type: "text.delta", partId: "text", text: step.text };
      yield { type: "message.completed", message: { role: "assistant", parts: [{ type: "text", text: step.text }] } };
      yield { type: "finished", reason: "stop" };
    } else {
      const parts = step.calls.map((call, index) => ({
        type: "tool-call" as const,
        callId: `call-${this.requests.length}-${index}`,
        ...call,
      }));
      for (const part of parts) yield { ...part, type: "tool.call" };
      yield { type: "message.completed", message: { role: "assistant", parts } };
      yield { type: "finished", reason: "tool-calls" };
    }
  }
}

const call = (name: string, input: JsonValue = {}): Step => ({ calls: [{ name, input }] });
const write = (path: string): Step => call("write_file", { path, content: `content of ${path}` });
const failure = (code: string, outcome: "known" | "unknown" = "known"): RunnerFailure => ({
  code,
  outcome,
  message: "Runner operation failed.",
});
const normalize = (path: string) => posix.normalize(path.replaceAll("\\", "/"));

/** Prototype methods deliberately catch regressions from spreading an injected SDK filesystem. */
class MemoryFiles implements FileSystem {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  writeFailure: RunnerFailure | undefined;
  beforeWrite: (() => Promise<void>) | undefined;
  async read(path: string): ReturnType<FileSystem["read"]> {
    const text = this.files.get(normalize(path));
    if (text === undefined) return { ok: false, error: failure("NOT_FOUND") };
    return {
      ok: true,
      value: {
        text,
        startLine: 1,
        endLine: text.split("\n").length,
        totalSize: Buffer.byteLength(text),
        sha256: createHash("sha256").update(text).digest("hex"),
        truncated: false,
        lineTruncated: false,
      },
    };
  }
  async readBytes(path: string): ReturnType<FileSystem["readBytes"]> {
    const result = await this.read(path);
    return result.ok ? { ok: true, value: new TextEncoder().encode(result.value.text) } : result;
  }
  async list(): ReturnType<FileSystem["list"]> {
    return {
      ok: true,
      value: [...this.files].map(([path, text]) => ({ path, kind: "file", sizeBytes: Buffer.byteLength(text) })),
    };
  }
  async grep(): ReturnType<FileSystem["grep"]> {
    return { ok: true, value: { matches: [], truncated: false } };
  }
  async write(path: string, content: string): ReturnType<FileSystem["write"]> {
    this.writes.push(path);
    await this.beforeWrite?.();
    if (this.writeFailure) return { ok: false, error: this.writeFailure };
    const created = !this.files.has(normalize(path));
    this.files.set(normalize(path), content);
    return {
      ok: true,
      value: {
        path,
        sha256: createHash("sha256").update(content).digest("hex"),
        sizeBytes: Buffer.byteLength(content),
        created,
      },
    };
  }
  async patch(path: string, edits: readonly { oldText: string; newText: string }[]): ReturnType<FileSystem["patch"]> {
    const original = this.files.get(normalize(path));
    if (original === undefined) return { ok: false, error: failure("NOT_FOUND") };
    const content = edits.reduce((text, edit) => text.replace(edit.oldText, edit.newText), original);
    const result = await this.write(path, content);
    return result.ok ? { ok: true, value: { ...result.value, editCount: edits.length } } : result;
  }
}

function remote(files = new MemoryFiles()) {
  const contexts: ToolContextOptions[] = [];
  let closed = false;
  const commands: string[] = [];
  const identity = {
    runnerId: "test-runner",
    bootId: "boot",
    protocolVersion: 1,
    version: "test",
    platform: "test",
    workspaces: [{ workspaceId: "project", displayName: "Project", permission: "READ_WRITE" as const }],
    capabilities: [],
    maxConcurrency: 4,
  };
  const session: RunnerSession = {
    identity,
    bootId: "boot",
    connectionEpoch: "epoch",
    connected: true,
    workspaces: identity.workspaces,
    createToolContext(options) {
      contexts.push(options);
      return {
        fs: files,
        cwd: options.cwd ?? ".",
        signal: options.signal,
        async exec(command) {
          commands.push(command);
          return {
            ok: true,
            value: {
              operationId: options.executionId,
              exitCode: 0,
              stdout: "ok",
              stderr: "",
              durationMs: 1,
              truncated: false,
              outputGap: false,
            },
          };
        },
      };
    },
    onStatus: () => () => undefined,
    cancel: async (): Promise<Result<void>> => ({ ok: true, value: undefined }),
    query: async () => ({ ok: false, error: failure("NOT_FOUND") }),
    close: async () => {
      closed = true;
    },
  };
  return { session, workspaceId: "project", files, contexts, commands, wasClosed: () => closed };
}

function hostTool(
  name: string,
  effects: ToolDefinition["effects"],
  execute = async (): Promise<JsonValue> => ({ ok: true }),
) {
  return defineDynamicTool({
    name,
    description: name,
    effects,
    inputSchema: { type: "object" },
    outputSchema: { type: "object", additionalProperties: true },
    execute,
  });
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

test("chat needs no Runner and forwards multimodal input, project identity, run ID and reasoning", async (t) => {
  const model = new ScriptedModel([{ text: "first" }, { text: "second" }]);
  const harness = await createCodingHarness({
    model: model.binding(),
    namespace: "tenant",
    identity: { userId: "owner" },
    instructions: "Use Chinese.",
  });
  t.after(() => harness.close());
  assert.deepEqual((await harness.inspect()).allowedTools, []);
  assert.equal((await harness.inspect()).namespace, "tenant");
  const result = await harness.run(
    {
      role: "user",
      parts: [
        { type: "text", text: "Describe the image" },
        { type: "image", reference: { id: "image", uri: "host://image", mediaType: "image/png", sizeBytes: 4 } },
      ],
    },
    { runId: "run-1", reasoningEffort: "high" },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.runId, "run-1");
  assert.equal(model.requests[0]?.reasoningEffort, "high");
  assert.match(JSON.stringify(model.requests[0]?.messages), /Use Chinese/);
  await harness.run("Follow up");
  assert.match(JSON.stringify(model.requests[1]?.messages), /Describe the image/);
  assert.match(JSON.stringify(model.requests[1]?.messages), /first/);
});

test("plan gate blocks same-batch writes until confirmed, then permits general project changes and commands", async (t) => {
  const runner = remote();
  const model = new ScriptedModel([
    {
      calls: [
        { name: "write_file", input: { path: "plan.md", content: "Plan" } },
        { name: "write_file", input: { path: "too-early.ts", content: "No" } },
      ],
    },
    write("src/service.ts"),
    call("bash", { command: "node", args: ["--version"] }),
    { text: "done" },
  ]);
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: runner.workspaceId,
    model: model.binding(),
    cwd: "project-dir",
  });
  t.after(() => harness.close());
  const result = await harness.run("Implement a service");
  assert.equal(result.status, "succeeded");
  assert.equal(result.toolCalls[1]?.error?.code, "TOOL_DENIED");
  assert.equal(result.toolCalls[1]?.outcome, "known");
  assert.deepEqual(runner.files.writes, ["plan.md", "src/service.ts"]);
  assert.deepEqual(runner.commands, ["node"]);
  assert.ok(
    runner.contexts.every(
      (context) =>
        context.workspaceId === "project" &&
        context.cwd === "project-dir" &&
        context.executionId &&
        context.idempotencyKey,
    ),
  );
  assert.doesNotMatch(JSON.stringify(model.requests[0]?.messages), /Implement only index.html/);
  await harness.close();
  assert.equal(runner.wasClosed(), false);
});

test("effects from contributed tools determine pre-plan reads and authorization remains an intersection", async (t) => {
  const runner = remote();
  const readTool = hostTool("web_search", "read");
  let writeCount = 0;
  const sideEffect = hostTool("deploy", "external-job", async () => {
    writeCount++;
    return {};
  });
  const plugin: PluginDefinition = {
    manifest: {
      id: "test.tools",
      version: "1.0.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [],
      contributes: [toolDefinitions],
    },
    setup(context) {
      context.contribute(toolDefinitions, readTool);
    },
  };
  const model = new ScriptedModel([
    call("web_search"),
    call("deploy"),
    write("plan.md"),
    call("deploy"),
    { text: "done" },
  ]);
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: "project",
    model: model.binding(),
    tools: [sideEffect],
    plugins: [plugin],
    allowedTools: ["web_search", "deploy", "write_file"],
    policies: [
      {
        id: "tenant-approval",
        authorize: async ({ name, context }) => {
          assert.equal(context.identity.userId, "owner");
          return name === "deploy" ? "deny" : "allow";
        },
      },
    ],
    identity: { userId: "owner" },
  });
  t.after(() => harness.close());
  const result = await harness.run("Work");
  assert.equal(result.toolCalls[0]?.status, "succeeded", JSON.stringify(result));
  assert.equal(result.toolCalls[1]?.error?.code, "TOOL_DENIED");
  assert.equal(result.toolCalls[3]?.error?.code, "TOOL_DENIED");
  assert.equal(writeCount, 0);
});

test("a failed plan write does not unlock effects; a later successful write does", async (t) => {
  const runner = remote();
  runner.files.writeFailure = failure("IO");
  const model = new ScriptedModel([
    write("plan.md"),
    write("blocked.ts"),
    {
      ...write(".\\plan.md"),
      check() {
        runner.files.writeFailure = undefined;
      },
    },
    write("allowed.ts"),
    { text: "done" },
  ]);
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: "project",
    model: model.binding(),
  });
  t.after(() => harness.close());
  const result = await harness.run("Work");
  assert.equal(result.toolCalls[0]?.error?.code, "IO");
  assert.equal(result.toolCalls[1]?.error?.code, "TOOL_DENIED");
  assert.equal(result.toolCalls[3]?.status, "succeeded");
  assert.deepEqual(runner.files.writes, ["plan.md", ".\\plan.md", "allowed.ts"]);
});

test("unknown remote outcomes stop the real loop without replaying or issuing another model request", async (t) => {
  const runner = remote();
  runner.files.writeFailure = failure("OUTCOME_UNKNOWN", "unknown");
  const model = new ScriptedModel([write("plan.md")]);
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: "project",
    model: model.binding(),
  });
  t.after(() => harness.close());
  const result = await harness.run("Work");
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "TOOL_OUTCOME_UNKNOWN");
  assert.equal(result.toolCalls[0]?.outcome, "unknown");
  assert.equal(model.requests.length, 1);
  assert.equal(runner.files.writes.length, 1);
});

test("custom plan paths, trusted restoration, legacy restoration and disabled gates remain distinct", async (t) => {
  for (const configuration of [
    {
      profile: { ...codingProfile, plan: { path: "plans/next.md" } },
      steps: [write("plans\\next.md"), write("main.ts"), { text: "done" }],
    },
    {
      profile: { ...dashboardProfile, plan: { alreadyWritten: true } },
      steps: [write("index.html"), { text: "done" }],
    },
    { planAlreadyAccepted: true, steps: [write("main.ts"), { text: "done" }] },
    { profile: { systemPrompt: "Perform the authorized task." }, steps: [write("main.ts"), { text: "done" }] },
  ]) {
    const runner = remote();
    const model = new ScriptedModel(configuration.steps);
    const harness = await createCodingHarness({
      session: runner.session,
      workspaceId: "project",
      model: model.binding(),
      ...("profile" in configuration
        ? { profile: configuration.profile }
        : { planAlreadyAccepted: configuration.planAlreadyAccepted }),
    });
    t.after(() => harness.close());
    const result = await harness.run("Work");
    assert.ok(result.toolCalls.every((item) => item.status === "succeeded"));
  }
  const fresh = remote();
  const harness = await createCodingHarness({
    session: fresh.session,
    workspaceId: "project",
    model: new ScriptedModel([write("main.ts"), { text: "denied" }]).binding(),
  });
  t.after(() => harness.close());
  assert.equal((await harness.run("Work")).toolCalls[0]?.error?.code, "TOOL_DENIED");
});

test("component replacement restores history without duplicate providers, and additive compaction works", async (t) => {
  const model = new ScriptedModel([{ text: "done" }]);
  const initial: SessionSnapshot = {
    revision: 3,
    runs: [],
    executions: [],
    messages: [
      { role: "user", parts: [{ type: "text", text: "Original goal" }] },
      { role: "assistant", parts: [{ type: "text", text: "Investigating" }] },
      { role: "user", parts: [{ type: "text", text: "Keep the existing interface" }] },
      { role: "assistant", parts: [{ type: "text", text: "Understood" }] },
    ],
  };
  let commits = 0;
  let latestSnapshot: SessionSnapshot | undefined;
  const harness = await createCodingHarness({
    model: model.binding(),
    components: {
      sessionStore: memorySessionPlugin({
        initialSnapshot: initial,
        onCommit: (snapshot) => {
          commits++;
          latestSnapshot = snapshot;
        },
      }),
      context: { ...contextPlugin(), manifest: { ...contextPlugin().manifest, id: "test.context" } },
      toolRuntime: { ...toolRuntimePlugin(), manifest: { ...toolRuntimePlugin().manifest, id: "test.runtime" } },
    },
    plugins: [summaryCompactionPlugin({ keepRecentMessages: 2, thresholdRatio: 0.0001 })],
  });
  t.after(() => harness.close());
  assert.equal((await harness.inspect()).revision, 3);
  assert.equal((await harness.run("Continue")).status, "succeeded");
  assert.match(JSON.stringify(model.requests[0]?.messages), /Original goal/);
  assert.ok(commits > 0);
  assert.equal(
    harness
      .inspectPlugins()
      .filter((plugin) => plugin.provides.some((key) => typeof key === "object" && key.id === "session.store")).length,
    1,
  );
  assert.equal((await harness.compact()).status, "compacted");
  assert.match(latestSnapshot?.summary?.text ?? "", /Original goal/);
});

test("plan gating works when the default tool runtime is replaced under a different plugin ID", async (t) => {
  const runner = remote();
  const runtime = toolRuntimePlugin();
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: "project",
    model: new ScriptedModel([write("plan.md"), write("main.ts"), { text: "done" }]).binding(),
    components: { toolRuntime: { ...runtime, manifest: { ...runtime.manifest, id: "test.replaced-runtime" } } },
  });
  t.after(() => harness.close());
  assert.equal((await harness.run("Work")).status, "succeeded");
  assert.deepEqual(runner.files.writes, ["plan.md", "main.ts"]);
});

test("late session setup failure rolls back kernel resources and additive provider conflicts are rejected", async () => {
  const model = new ScriptedModel([]);
  await assert.rejects(createCodingHarness({ model: model.binding(), allowedTools: ["missing"] }), {
    code: "UNKNOWN_TOOL",
  });
  assert.equal(model.disposed, 1);
  const duplicateStore = memorySessionPlugin();
  await assert.rejects(
    createCodingHarness({
      model: new ScriptedModel([]).binding(),
      plugins: [{ ...duplicateStore, manifest: { ...duplicateStore.manifest, id: "test.duplicate-store" } }],
    }),
    { code: "CAPABILITY_CONFLICT" },
  );
});

test("invalid execution, budgets, credentials, plan paths and duplicate registrations fail before model I/O", async () => {
  const runner = remote();
  const model = new ScriptedModel([]);
  const base = { model: model.binding() };
  for (const options of [
    { ...base, session: runner.session },
    { ...base, workspaceId: "project" },
    { ...base, cwd: "." },
    { ...base, session: runner.session, workspaceId: "unknown" },
    { ...base, profile: codingProfile },
    { ...base, maxSteps: 0 },
    { ...base, maxRunMs: 2_147_483_648 },
    { ...base, maxParallelWrites: Number.NaN },
    { ...base, maxToolCalls: 1.5 },
    {
      ...base,
      session: runner.session,
      workspaceId: "project",
      profile: { ...codingProfile, plan: { path: "../plan.md" } },
    },
    {
      ...base,
      session: runner.session,
      workspaceId: "project",
      profile: { ...codingProfile, plan: { path: "C:\\plan.md" } },
    },
    {
      ...base,
      session: runner.session,
      workspaceId: "project",
      profile: { ...codingProfile, plan: { alreadyWritten: false } },
      planAlreadyAccepted: true,
    },
    { ...base, tools: [hostTool("same", "read"), hostTool("same", "write")] },
    {
      ...base,
      policies: [
        { id: "same", authorize: async () => "allow" as const },
        { id: "same", authorize: async () => "deny" as const },
      ],
    },
    { model: { baseURL: "https://example.com/v1", apiKey: " ", model: "test" } },
  ])
    await assert.rejects(createCodingHarness(options as CodingHarnessOptions), TypeError);
  assert.equal(model.requests.length, 0);
});

test("event and result observers are isolated from mutation and synchronous or asynchronous failure", async (t) => {
  const diagnostics: SafeError[] = [];
  const perRun: AgentEvent[] = [];
  let oldCallbackResult: RunResult | undefined;
  const harness = await createCodingHarness({
    model: new ScriptedModel([{ text: "answer" }]).binding(),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onEvent(event) {
      event.runId = "mutated";
      throw new Error("private credential");
    },
    onRunResult: async (result) => {
      result.text = "mutated";
      throw new Error("private credential");
    },
    onToolResult: (result) => {
      oldCallbackResult = result;
    },
  });
  t.after(() => harness.close());
  const result = await harness.run("Hello", { runId: "original", onEvent: (event) => perRun.push(event) });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(result.text, "answer");
  assert.equal(oldCallbackResult?.text, "answer");
  assert.ok(perRun.length > 0 && perRun.every((event) => event.runId === "original"));
  assert.ok(diagnostics.length > 0 && diagnostics.every((diagnostic) => diagnostic.code === "OBSERVER_FAILED"));
  assert.doesNotMatch(JSON.stringify(diagnostics), /private credential/);
});

test("cancel reaches the model, rejects overlapping runs and leaves the session reusable", async (t) => {
  const started = Promise.withResolvers<void>();
  const model = new ScriptedModel([
    {
      text: "unused",
      check: async (request) => {
        started.resolve();
        await waitForAbort(request.signal);
      },
    },
    { text: "next" },
  ]);
  const harness = await createCodingHarness({ model: model.binding() });
  t.after(() => harness.close());
  const running = harness.run("Start");
  await started.promise;
  await assert.rejects(harness.run("Overlap"), { code: "BUSY" });
  harness.cancel();
  assert.equal((await running).status, "cancelled");
  assert.equal(model.requests[0]?.signal.aborted, true);
  assert.equal((await harness.run("Again")).text, "next");
});

test("cancellation and execution identity reach the injected Runner context", async (t) => {
  const runner = remote();
  const started = Promise.withResolvers<void>();
  const harness = await createCodingHarness({
    session: runner.session,
    workspaceId: "project",
    model: new ScriptedModel([write("plan.md")]).binding(),
    createContext(input, options) {
      const context = options.session.createToolContext({
        workspaceId: options.workspaceId,
        signal: input.signal,
        executionId: input.executionId,
        idempotencyKey: input.idempotencyKey,
      });
      runner.files.beforeWrite = async () => {
        started.resolve();
        await waitForAbort(input.signal);
      };
      runner.files.writeFailure = failure("CANCELLED");
      return context;
    },
  });
  t.after(() => harness.close());
  const running = harness.run("Work");
  await started.promise;
  harness.cancel();
  assert.equal((await running).status, "cancelled");
  assert.equal(runner.contexts[0]?.signal.aborted, true);
});

test("facade deadlines cap caller timeouts and invalid timeouts do not start an operation", async (t) => {
  const model = new ScriptedModel([{ text: "unused", check: async (request) => waitForAbort(request.signal) }]);
  const harness = await createCodingHarness({ model: model.binding(), maxRunMs: 30 });
  t.after(() => harness.close());
  await assert.rejects(harness.run("Invalid", { timeoutMs: Number.NaN }), TypeError);
  await assert.rejects(harness.run("Invalid", { timeoutMs: 0 }), TypeError);
  assert.equal(model.requests.length, 0);
  assert.equal((await harness.run("Wait", { timeoutMs: 60_000 })).status, "timed_out");
});

test("close callers share cleanup completion and its failure, and closing rejects new work", async () => {
  for (const cleanupFails of [false, true]) {
    const release = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const model = new ScriptedModel([]);
    model.cleanup = async () => {
      started.resolve();
      await release.promise;
      if (cleanupFails) throw new Error("cleanup");
    };
    const harness = await createCodingHarness({ model: model.binding() });
    const first = harness.close();
    const second = harness.close();
    assert.equal(first, second);
    await started.promise;
    await assert.rejects(harness.run("Closed"), { code: "CLOSED" });
    const settled = Promise.allSettled([first, second]);
    release.resolve();
    const results = await settled;
    assert.ok(results.every((result) => result.status === (cleanupFails ? "rejected" : "fulfilled")));
    assert.equal(model.disposed, 1);
  }
});

test("model updates keep a stable configuration snapshot throughout an active run", async (t) => {
  const model = new ScriptedModel([
    {
      ...call("lookup"),
      check() {
        harness.updateModel({ route: "new" });
      },
    },
    { text: "first" },
    { text: "second" },
  ]);
  const harness = await createCodingHarness({ model: model.binding(), tools: [hostTool("lookup", "read")] });
  t.after(() => harness.close());
  await harness.run("First");
  await harness.run("Second");
  assert.deepEqual(
    model.requests.map((request) => request.route?.configVersion),
    [1, 1, 2],
  );
});

test("a replacement loop can suspend and resume with bounded deadlines and facade result observations", async (t) => {
  const observations: RunResult[] = [];
  const timeouts: number[] = [];
  const usage = { inputTokens: null, outputTokens: null, cachedInputTokens: null, reasoningTokens: null };
  const loop: PluginDefinition = {
    manifest: {
      id: "test.waiting-loop",
      version: "1.0.0",
      apiVersion: 1,
      scope: "session",
      requires: [sessionDefinition],
      provides: [agentExecutor],
    },
    setup(context) {
      const definition = context.resolve(sessionDefinition);
      context.provide(agentExecutor, {
        async execute(run) {
          timeouts.push(run.deadlineAt - Date.now());
          const base = { sessionId: definition.sessionId, runId: run.runId, text: "", toolCalls: [], usage };
          return run.resume
            ? { ...base, kind: "completed", status: "succeeded", text: JSON.stringify(run.resume.input) }
            : { ...base, kind: "suspended", status: "waiting_input", continuationId: "approval-1" };
        },
        async compact() {
          return { status: "compacted" };
        },
      });
    },
  };
  const harness = await createCodingHarness({
    model: new ScriptedModel([]).binding(),
    components: { loop },
    maxRunMs: 1_000,
    onRunResult: (result) => {
      observations.push(result);
    },
  });
  t.after(() => harness.close());
  const waiting = await harness.run("Begin", { runId: "task" });
  assert.equal(waiting.status, "waiting_input");
  assert.equal((await harness.inspect()).waiting, true);
  await assert.rejects(harness.resume({ runId: "task", continuationId: "wrong", input: {} }), {
    code: "INVALID_CONTINUATION",
  });
  const result = await harness.resume({
    runId: "task",
    continuationId: "approval-1",
    input: { allow: true },
    timeoutMs: 60_000,
  });
  assert.equal(result.text, '{"allow":true}');
  assert.equal((await harness.inspect()).waiting, false);
  assert.equal(observations.length, 2);
  assert.ok(timeouts.every((timeout) => timeout > 0 && timeout <= 1_000));
  assert.equal((await harness.compact()).status, "skipped");
});

test("tool budgets stop dispatch before exceeding the configured call limit", async (t) => {
  let calls = 0;
  const model = new ScriptedModel([call("lookup"), call("lookup")]);
  const harness = await createCodingHarness({
    model: model.binding(),
    maxToolCalls: 1,
    tools: [
      hostTool("lookup", "read", async () => {
        calls++;
        return {};
      }),
    ],
  });
  t.after(() => harness.close());
  assert.equal((await harness.run("Work")).error?.code, "TOOL_LIMIT");
  assert.equal(calls, 1);
});
