import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import test from "node:test";
import {
  agentExecutor,
  FrameworkError,
  defineDynamicTool,
  modelRouter,
  sessionDefinition,
  sessionStore,
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
import { modelCompactionPlugin, summaryCompactionPlugin } from "@nnova/harness/plugins/compaction";
import { toolLoopDetectionPlugin, type RepeatedToolCallConfirmation } from "@nnova/harness/plugins/tool-loop-detection";
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
  const unsupported = async (): Promise<{ ok: false; error: RunnerFailure }> => ({
    ok: false,
    error: failure("UNSUPPORTED"),
  });
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
    supportsLocalResources: () => false,
    supportsLocalResourceWrites: () => false,
    onResourceCatalog: () => () => undefined,
    refreshResources: unsupported,
    readResourceSnapshot: unsupported,
    writeResourceFile: unsupported,
    deleteWorkspacePaths: unsupported,
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
    inputSchema: { type: "object", additionalProperties: true },
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

test("large command output preserves the exit status and reaches the next model step", async (t) => {
  for (const scenario of [
    { stdout: "s".repeat(65_536), stderr: "", limit: 100_000, exitCode: 0 },
    { stdout: '输出😀"\n'.repeat(1_000), stderr: "警告\t\u0001".repeat(1_000), limit: 8_000, exitCode: 7 },
  ]) {
    const { stdout, stderr, limit, exitCode } = scenario;
    const runner = remote();
    const events: AgentEvent[] = [];
    const model = new ScriptedModel([call("bash", { command: "fixture", args: [] }), { text: "done" }]);
    const harness = await createCodingHarness({
      session: runner.session,
      workspaceId: runner.workspaceId,
      model: model.binding(),
      profile: { systemPrompt: "Run the command." },
      maxToolOutputBytes: limit,
      onEvent(event) {
        events.push(event);
      },
      createContext: (context) => ({
        fs: runner.files,
        cwd: ".",
        signal: context.signal,
        async exec(_command, options) {
          options?.onOutput?.({ stream: "stdout", text: stdout });
          if (stderr) options?.onOutput?.({ stream: "stderr", text: stderr });
          return {
            ok: true,
            value: {
              operationId: context.executionId,
              exitCode,
              stdout,
              stderr,
              durationMs: 1,
              truncated: false,
              outputGap: false,
            },
          };
        },
      }),
    });
    t.after(() => harness.close());

    const result = await harness.run("Run command");
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    const tool = result.toolCalls[0];
    assert.equal(tool?.status, "succeeded");
    assert.equal(model.requests.length, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(tool.value)) <= limit);
    const value = tool.value;
    assert.ok(value && typeof value === "object" && !Array.isArray(value));
    assert.equal(value.status, exitCode === 0 ? "ok" : "error");
    const details = value.details;
    assert.ok(details && typeof details === "object" && !Array.isArray(details));
    assert.equal(details.exitCode, exitCode);
    assert.equal(details.truncated, true);
    assert.equal(details.outputGap, false);
    assert.ok(typeof details.stdout === "string");
    assert.match(details.stdout, /partial output truncated/);
    if (stderr) {
      assert.ok(typeof details.stderr === "string");
      assert.match(details.stderr, /partial output truncated/);
    }
    assert.deepEqual(
      events.filter((event) => event.type === "tool.output").map((event) => event.text),
      [stdout, stderr].filter(Boolean),
    );
  }
});

test("rejecting a returned result at the output boundary leaves its outcome known", async (t) => {
  const model = new ScriptedModel([call("large_result"), { text: "done" }]);
  const harness = await createCodingHarness({
    model: model.binding(),
    tools: [hostTool("large_result", "write", async () => ({ stdout: "s".repeat(1_000) }))],
    maxToolOutputBytes: 128,
  });
  t.after(() => harness.close());

  const result = await harness.run("Run tool");
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(result.toolCalls[0]?.status, "failed");
  assert.equal(result.toolCalls[0]?.error?.code, "INVALID_TOOL_OUTPUT");
  assert.equal(result.toolCalls[0]?.outcome, "known");
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

test("component replacement restores history without duplicate providers and replaces compaction", async (t) => {
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
      compaction: summaryCompactionPlugin({ keepRecentMessages: 2, thresholdRatio: 0.0001 }),
    },
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
  assert.equal((await harness.compact()).status, "compacted");
});

test("work steps and tool calls are unlimited by default", async (t) => {
  for (const toolSteps of [33, 96]) {
    await t.test(`${toolSteps} tool steps`, async (t) => {
      const model = new ScriptedModel([
        ...Array.from({ length: toolSteps }, () => call("lookup")),
        {
          text: "done",
          check(request) {
            assert.equal(request.messages.filter((message) => message.role === "tool").length, toolSteps);
          },
        },
      ]);
      const harness = await createCodingHarness({ model: model.binding(), tools: [hostTool("lookup", "read")] });
      t.after(() => harness.close());
      const result = await harness.run("Work");
      assert.equal(result.toolCalls.length, toolSteps);
      assert.equal(result.status, "succeeded");
      assert.equal(result.text, "done");
    });
  }
});

test("explicit step and tool budgets reserve a text-only summary and reset for another run", async (t) => {
  for (const [budget, reason] of [
    [{ maxSteps: 1 }, "STEP_LIMIT"],
    [{ maxToolCalls: 1 }, "TOOL_LIMIT"],
  ] as const) {
    await t.test(reason, async (t) => {
      const model = new ScriptedModel([
        call("lookup"),
        {
          text: "One lookup finished; implementation remains.",
          check(request) {
            assert.equal(request.toolChoice, "none");
          },
        },
        { text: "continued" },
      ]);
      const harness = await createCodingHarness({
        model: model.binding(),
        ...budget,
        tools: [hostTool("lookup", "read")],
      });
      t.after(() => harness.close());
      const result = await harness.run("Work");
      assert.equal(result.status, "budget_exhausted");
      assert.equal(result.kind === "completed" && result.budgetReason, reason);
      assert.equal(result.error, undefined);
      assert.equal(result.toolCalls.length, 1);
      assert.match(result.text, /implementation remains/);
      assert.equal((await harness.run("Continue")).text, "continued");
    });
  }
});

test("tool budgets reject an oversized batch before dispatch and keep tool history paired", async (t) => {
  let calls = 0;
  const model = new ScriptedModel([
    {
      calls: [
        { name: "lookup", input: {} },
        { name: "lookup", input: {} },
      ],
    },
    {
      text: "Budget too small for the requested batch.",
      check(request) {
        assert.equal(request.toolChoice, "none");
        assert.equal(request.messages.filter((message) => message.role === "tool").length, 2);
      },
    },
  ]);
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
  assert.equal((await harness.run("Work")).status, "budget_exhausted");
  assert.equal(calls, 0);
});

test("automatic model compaction preserves recent tool pairs and merges repeated summaries without deleting history", async (t) => {
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 };
  const model = new ScriptedModel([
    {
      text: "Goal retained; first lookup complete.",
      check(request) {
        assert.equal(request.toolChoice, "none");
      },
    },
    {
      text: "first answer",
      check(request) {
        assert.match(JSON.stringify(request.messages), /Goal retained/);
        assert.equal(request.messages.filter((message) => message.role === "tool").length, 1);
      },
    },
    {
      text: "Goal retained; first answer verified; new task pending.",
      check(request) {
        assert.match(JSON.stringify(request.messages), /Goal retained; first lookup complete/);
      },
    },
    {
      text: "second answer",
      check(request) {
        assert.match(JSON.stringify(request.messages), /new task pending/);
      },
    },
  ]);
  const stream = model.stream.bind(model);
  model.stream = async function* (request) {
    for await (const chunk of stream(request)) {
      if (chunk.type === "finished") yield { type: "usage", usage };
      yield chunk;
    }
  };
  const messages: SessionSnapshot["messages"] = [
    { role: "user", parts: [{ type: "text", text: "Original goal " + "details ".repeat(40) }] },
    { role: "assistant", parts: [{ type: "text", text: "Investigating" }] },
    { role: "assistant", parts: [{ type: "tool-call", callId: "old-call", name: "lookup", input: {} }] },
    {
      role: "tool",
      parts: [{ type: "tool-result", callId: "old-call", name: "lookup", status: "succeeded", value: { found: true } }],
    },
  ];
  let saved: SessionSnapshot | undefined;
  const harness = await createCodingHarness({
    model: model.binding(),
    tools: [hostTool("lookup", "read")],
    components: {
      sessionStore: memorySessionPlugin({
        initialSnapshot: { revision: 0, messages, runs: [], executions: [] },
        onCommit: (snapshot) => {
          saved = snapshot;
        },
      }),
      compaction: modelCompactionPlugin({ thresholdRatio: 0.0001, keepRecentMessages: 2 }),
    },
  });
  t.after(() => harness.close());
  const first = await harness.run("Continue");
  assert.equal(first.status, "succeeded", JSON.stringify(first.error));
  assert.equal(first.usage.inputTokens, 20);
  assert.equal(first.usage.outputTokens, 4);
  assert.equal(saved?.messages.length, 6);
  assert.equal(saved?.summary?.throughMessage, 2, "a tool call cannot be separated from its result");
  const second = await harness.run("Next");
  assert.equal(second.status, "succeeded", JSON.stringify(second.error));
  assert.equal(saved?.messages.length, 8);
  assert.match(saved?.summary?.text ?? "", /first answer verified/);
});

test("cancellation and deadlines still interrupt budget summaries", async (t) => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? "cancel" : "timeout", async (t) => {
      const started = Promise.withResolvers<void>();
      const model = new ScriptedModel([
        call("lookup"),
        {
          text: "unused",
          check: async (request) => {
            assert.equal(request.toolChoice, "none");
            started.resolve();
            await waitForAbort(request.signal);
          },
        },
      ]);
      const harness = await createCodingHarness({
        model: model.binding(),
        maxSteps: 1,
        maxRunMs: cancel ? 5_000 : 100,
        tools: [hostTool("lookup", "read")],
      });
      t.after(() => harness.close());
      const running = harness.run("Work");
      await started.promise;
      if (cancel) harness.cancel();
      assert.equal((await running).status, cancel ? "cancelled" : "timed_out");
    });
  }
});

test("failed or cancelled compaction leaves the original history and summary untouched", async (t) => {
  for (const cancel of [false, true]) {
    await t.test(cancel ? "cancel" : "model failure", async (t) => {
      const started = Promise.withResolvers<void>();
      const model = new ScriptedModel([
        {
          text: "unused",
          check: async (request) => {
            assert.equal(request.toolChoice, "none");
            started.resolve();
            if (cancel) await waitForAbort(request.signal);
            else throw new Error("private provider details");
          },
        },
      ]);
      const original: SessionSnapshot = {
        revision: 0,
        runs: [],
        executions: [],
        messages: [
          { role: "user", parts: [{ type: "text", text: "original objective" }] },
          { role: "assistant", parts: [{ type: "text", text: "verified progress" }] },
          { role: "user", parts: [{ type: "text", text: "more work" }] },
          { role: "assistant", parts: [{ type: "text", text: "pending edits" }] },
        ],
      };
      let saved: SessionSnapshot | undefined;
      const harness = await createCodingHarness({
        model: model.binding(),
        components: {
          sessionStore: memorySessionPlugin({
            initialSnapshot: original,
            onCommit: (snapshot) => {
              saved = snapshot;
            },
          }),
          compaction: modelCompactionPlugin({ thresholdRatio: 0.0001, keepRecentMessages: 1 }),
        },
      });
      t.after(() => harness.close());
      const running = harness.run("Continue");
      await started.promise;
      if (cancel) harness.cancel();
      const result = await running;
      assert.equal(result.status, cancel ? "cancelled" : "failed");
      assert.equal(saved?.summary, undefined);
      assert.deepEqual(saved?.messages.slice(0, original.messages.length), original.messages);
      assert.doesNotMatch(JSON.stringify(result), /private provider details/);
    });
  }
});

test("recovery after committing a budget summary preserves its terminal meaning without another model request", async (t) => {
  let saved: SessionSnapshot | undefined;
  const first = await createCodingHarness({
    model: new ScriptedModel([call("lookup"), { text: "Budget exhausted; more work remains." }]).binding(),
    maxSteps: 1,
    tools: [hostTool("lookup", "read")],
    components: {
      sessionStore: memorySessionPlugin({
        onCommit(snapshot) {
          saved = snapshot;
          const continuation = snapshot.continuation;
          if (
            continuation &&
            typeof continuation === "object" &&
            !Array.isArray(continuation) &&
            continuation.phase === "completed"
          )
            throw new FrameworkError("PERSISTENCE_FAILED", "Commit acknowledgement lost");
        },
      }),
    },
  });
  t.after(() => first.close());
  await first.run("Work", { runId: "recover-budget" });
  assert.ok(saved);
  const continuation = saved.continuation;
  assert.ok(
    continuation &&
      typeof continuation === "object" &&
      !Array.isArray(continuation) &&
      typeof continuation.continuationId === "string",
  );
  const model = new ScriptedModel([]);
  const restored = await createCodingHarness({
    model: model.binding(),
    components: { sessionStore: memorySessionPlugin({ initialSnapshot: saved }) },
  });
  t.after(() => restored.close());
  const result = await restored.resume({
    runId: "recover-budget",
    continuationId: continuation.continuationId,
    input: null,
  });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(result.kind === "completed" && result.budgetReason, "STEP_LIMIT");
  assert.match(result.text, /more work remains/);
  assert.equal(model.requests.length, 0);
});

test("repetition detection adds no store loads when a locally confirmed snapshot is available", async (t) => {
  const loads: number[] = [];
  for (const enabled of [false, true]) {
    let count = 0;
    const instrumentation: PluginDefinition = {
      manifest: {
        id: "test.store-loads",
        version: "1.0.0",
        apiVersion: 1,
        scope: "session",
        requires: [sessionStore],
        provides: [],
      },
      setup(context) {
        const store = context.resolve(sessionStore);
        const load = store.load.bind(store);
        store.load = async () => {
          count++;
          return load();
        };
      },
    };
    const model = new ScriptedModel([...Array.from({ length: 5 }, () => call("lookup")), { text: "done" }]);
    const harness = await createCodingHarness({
      model: model.binding(),
      tools: [hostTool("lookup", "read")],
      plugins: [instrumentation, ...(enabled ? [toolLoopDetectionPlugin({ confirm: async () => "allow" })] : [])],
    });
    t.after(() => harness.close());
    assert.equal((await harness.run("Investigate")).status, "succeeded");
    loads.push(count);
  }
  assert.ok(loads[0]! > 0, "the real session persistence path must be exercised");
  assert.equal(loads[1], loads[0], "policy and warning checks must reuse the confirmed snapshot");
});

test("same-message repetitions require a scoped confirmation before the third invocation, including parallel calls", async (t) => {
  for (const decision of ["allow", "deny"] as const) {
    await t.test(decision, async (t) => {
      let executions = 0;
      let response: typeof decision | undefined;
      const requests = new Map<string, RepeatedToolCallConfirmation>();
      const batch: Step = {
        calls: [
          { name: "update", input: { x: 1, y: 2 } },
          { name: "update", input: { x: 2 } },
          { name: "update", input: { y: 2, x: 1 } },
          { name: "update", input: { x: 1, y: 2 } },
          { name: "update", input: { y: 2, x: 1 } },
        ],
      };
      const model = new ScriptedModel([batch, { text: "done" }, batch]);
      const harness = await createCodingHarness({
        model: model.binding(),
        tools: [
          hostTool("update", "write", async () => {
            executions++;
            return { ok: true };
          }),
        ],
        policies: [{ id: "ordinary-approval", authorize: async () => "allow" }],
        plugins: [
          toolLoopDetectionPlugin({
            confirm: async (request) => {
              requests.set(request.key, request);
              return response ?? { kind: "ask", continuationId: "loop-confirmation" };
            },
          }),
        ],
      });
      t.after(() => harness.close());
      const waiting = await harness.run("Work", { runId: "loop-run" });
      assert.equal(waiting.kind, "suspended");
      assert.equal(executions, 3, "only the first two repetitions and the different call may execute");
      assert.equal(requests.size, 1, "all later repetitions share one confirmation scope");
      assert.equal([...requests.values()][0]?.occurrences, 4);
      const firstKey = [...requests.keys()][0];
      response = decision;
      const result = await harness.resume({ runId: "loop-run", continuationId: "loop-confirmation", input: null });
      assert.equal(result.status, "succeeded", JSON.stringify(result.error));
      assert.equal(executions, decision === "allow" ? 5 : 3);
      assert.equal(result.toolCalls.filter((call) => call.status === "failed").length, decision === "deny" ? 2 : 0);
      assert.equal(model.requests.length, 2, "resume cannot replay the model or completed tools");
      response = undefined;
      const next = await harness.run("Another request", { runId: "next-loop-run" });
      assert.equal(next.kind, "suspended");
      assert.equal(requests.size, 2);
      assert.notEqual([...requests.keys()].at(-1), firstKey);
    });
  }
});

test("identical successful outputs warn on the third occurrence across interleaved calls, without changing results", async (t) => {
  const warned = (request: ModelStepRequest) => JSON.stringify(request.messages).includes("[Tool repetition warning]");
  const model = new ScriptedModel([
    call("lookup", { x: 1, y: 2 }),
    { ...call("lookup", { x: 2 }), check: (request) => assert.equal(warned(request), false) },
    call("lookup", { y: 2, x: 1 }),
    { ...call("lookup", { x: 2 }), check: (request) => assert.equal(warned(request), false) },
    call("lookup", { x: 1, y: 2 }),
    {
      ...call("lookup", { x: 3 }),
      check(request) {
        assert.equal(warned(request), true);
        for (const message of request.messages)
          for (const part of message.parts)
            if (part.type === "tool-result") assert.deepEqual(part.value, { found: true });
      },
    },
    { text: "changed approach", check: (request) => assert.equal(warned(request), false) },
    call("lookup", { x: 1, y: 2 }),
    call("lookup", { x: 1, y: 2 }),
    { text: "new turn", check: (request) => assert.equal(warned(request), false) },
  ]);
  const harness = await createCodingHarness({
    model: model.binding(),
    tools: [hostTool("lookup", "read", async () => ({ found: true }))],
    plugins: [
      toolLoopDetectionPlugin({
        confirm: async () => {
          throw new Error("One call per message must not need confirmation");
        },
      }),
    ],
  });
  t.after(() => harness.close());
  assert.equal((await harness.run("Investigate")).status, "succeeded");
  assert.equal((await harness.run("Recheck")).status, "succeeded");
});

test("changed outputs and failed calls reset identical-result streaks", async (t) => {
  let count = 0;
  const model = new ScriptedModel([
    ...Array.from({ length: 7 }, () => ({
      ...call("lookup"),
      check(request: ModelStepRequest) {
        assert.equal(JSON.stringify(request.messages).includes("[Tool repetition warning]"), false);
      },
    })),
    {
      text: "done",
      check(request) {
        assert.equal(JSON.stringify(request.messages).includes("[Tool repetition warning]"), false);
      },
    },
  ]);
  const harness = await createCodingHarness({
    model: model.binding(),
    tools: [
      hostTool("lookup", "read", async () => {
        count++;
        if (count === 5) throw new FrameworkError("NOT_FOUND", "Not found");
        return { version: count < 3 ? 1 : 2 };
      }),
    ],
    plugins: [toolLoopDetectionPlugin({ confirm: async () => "deny" })],
  });
  t.after(() => harness.close());
  assert.equal((await harness.run("Check changes")).status, "succeeded");
});

test("repetition confirmation survives a restart without replaying completed effects", async (t) => {
  let executions = 0;
  let saved: SessionSnapshot | undefined;
  let key: string | undefined;
  const tool = hostTool("update", "write", async () => {
    executions++;
    return { ok: true };
  });
  const first = await createCodingHarness({
    model: new ScriptedModel([{ calls: Array.from({ length: 3 }, () => ({ name: "update", input: {} })) }]).binding(),
    tools: [tool],
    components: {
      sessionStore: memorySessionPlugin({
        onCommit: (snapshot) => {
          saved = snapshot;
        },
      }),
    },
    plugins: [
      toolLoopDetectionPlugin({
        confirm: async (request) => {
          key = request.key;
          return { kind: "ask", continuationId: "durable-loop" };
        },
      }),
    ],
  });
  t.after(() => first.close());
  assert.equal((await first.run("Work", { runId: "durable-loop-run" })).kind, "suspended");
  assert.equal(executions, 2);
  assert.ok(saved);
  await first.close();
  const model = new ScriptedModel([
    {
      text: "resumed",
      check(request) {
        assert.match(JSON.stringify(request.messages), /Tool repetition warning/);
      },
    },
  ]);
  const restored = await createCodingHarness({
    model: model.binding(),
    tools: [tool],
    components: { sessionStore: memorySessionPlugin({ initialSnapshot: saved }) },
    plugins: [
      toolLoopDetectionPlugin({
        confirm: async (request) => {
          assert.equal(request.key, key);
          return "allow";
        },
      }),
    ],
  });
  t.after(() => restored.close());
  const result = await restored.resume({ runId: "durable-loop-run", continuationId: "durable-loop", input: null });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.equal(executions, 3);
  assert.equal(model.requests.length, 1);
});

test("compaction retains repetition evidence without copying warnings into saved tool output", async (t) => {
  let saved: SessionSnapshot | undefined;
  const model = new ScriptedModel([
    call("lookup"),
    call("lookup"),
    call("lookup"),
    {
      text: "use another approach",
      check(request) {
        assert.match(JSON.stringify(request.messages), /Tool repetition warning/);
        assert.ok(saved?.summary && saved.summary.throughMessage >= 5);
      },
    },
  ]);
  const harness = await createCodingHarness({
    model: model.binding(),
    tools: [hostTool("lookup", "read")],
    components: {
      compaction: summaryCompactionPlugin({ thresholdRatio: 0.0001, keepRecentMessages: 2 }),
      sessionStore: memorySessionPlugin({
        onCommit: (snapshot) => {
          saved = snapshot;
        },
      }),
    },
    plugins: [toolLoopDetectionPlugin({ confirm: async () => "deny" })],
  });
  t.after(() => harness.close());
  const result = await harness.run("Investigate");
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.doesNotMatch(JSON.stringify(saved?.messages), /Tool repetition warning/);
});

test("cancellation during repetition confirmation prevents subsequent dispatch", async (t) => {
  const entered = Promise.withResolvers<void>();
  let executions = 0;
  const harness = await createCodingHarness({
    model: new ScriptedModel([{ calls: Array.from({ length: 4 }, () => ({ name: "lookup", input: {} })) }]).binding(),
    tools: [
      hostTool("lookup", "read", async () => {
        executions++;
        return { ok: true };
      }),
    ],
    plugins: [
      toolLoopDetectionPlugin({
        confirm: async (request) => {
          entered.resolve();
          await waitForAbort(request.context.signal);
          return "allow";
        },
      }),
    ],
  });
  t.after(() => harness.close());
  const running = harness.run("Work");
  await entered.promise;
  harness.cancel();
  const result = await running;
  assert.equal(result.status, "cancelled");
  assert.ok(executions <= 2);
});
