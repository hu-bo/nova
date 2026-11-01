import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  createAgentKernel,
  defineTool,
  type AgentEvent,
  type FlowResult,
  type PluginInspection,
  type RunResult,
  type TaskResult,
} from "@nnova/harness";
import { z } from "zod";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";
import { aiSdkModelPlugin } from "@nnova/harness/plugins/model-ai-sdk";
import { agentTaskPlugin } from "@nnova/harness/plugins/agent-task";
import { basicLoopPlugin } from "@nnova/harness/plugins/basic-loop";
import { contextPlugin } from "@nnova/harness/plugins/context";
import { memoryTaskQueuePlugin } from "@nnova/harness/plugins/queue-memory";
import { memorySessionPlugin } from "@nnova/harness/plugins/session-memory";
import { taskEnginePlugin } from "@nnova/harness/plugins/task-engine";
import { memoryTaskStorePlugin } from "@nnova/harness/plugins/task-store-memory";
import { telemetryPlugin } from "@nnova/harness/plugins/telemetry";
import { toolRuntimePlugin } from "@nnova/harness/plugins/tools";

const SESSION_LIMIT = 16;
const RUN_TIMEOUT_MS = 90_000;
const namespaceFor = (id: string) => `demo-${id}`;

const sessionInput = z
  .object({
    provider: z.string().trim().min(1).max(80),
    baseURL: z.url(),
    apiKey: z.string().min(1).max(4096),
    model: z.string().trim().min(1).max(256),
  })
  .strict();

const runInput = z
  .object({
    text: z.string().trim().min(1).max(12_000),
    mode: z.enum(["task", "flow"]),
  })
  .strict();

type StreamEvent = Record<string, unknown>;
type SessionRuntime = {
  id: string;
  provider: string;
  model: string;
  kernel: Awaited<ReturnType<typeof createAgentKernel>>;
  running: boolean;
  emit: ((event: StreamEvent) => void) | undefined;
};

const sessions = new Map<string, SessionRuntime>();

const clockTool = defineTool({
  name: "get_beijing_time",
  description: "Return the current local date and time in Beijing, China.",
  effects: "read",
  inputSchema: z.object({}).strict(),
  outputSchema: z.object({ iso: z.string(), local: z.string(), timeZone: z.string() }).strict(),
  async execute() {
    const now = new Date();
    return {
      iso: now.toISOString(),
      local: new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "full",
        timeStyle: "long",
      }).format(now),
      timeZone: "Asia/Shanghai",
    };
  },
});

const calculatorTool = defineTool({
  name: "calculate",
  description: "Calculate one basic arithmetic operation with two numbers.",
  effects: "read",
  inputSchema: z
    .object({
      a: z.number().finite(),
      operation: z.enum(["add", "subtract", "multiply", "divide"]),
      b: z.number().finite(),
    })
    .strict(),
  outputSchema: z.object({ result: z.number(), expression: z.string() }).strict(),
  async execute({ a, operation, b }) {
    if (operation === "divide" && b === 0) throw new Error("Cannot divide by zero.");
    const symbol = { add: "+", subtract: "−", multiply: "×", divide: "÷" }[operation];
    const result =
      operation === "add" ? a + b : operation === "subtract" ? a - b : operation === "multiply" ? a * b : a / b;
    return { result, expression: `${a} ${symbol} ${b} = ${result}` };
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textFromRun(value: unknown): RunResult | undefined {
  if (!isRecord(value) || value.kind !== "completed" || typeof value.text !== "string") return undefined;
  return value as unknown as RunResult;
}

function publicRun(value: unknown) {
  const result = textFromRun(value);
  if (!result) return undefined;
  return {
    text: result.text,
    usage: result.usage,
    toolCalls: result.toolCalls.map((call) => ({
      name: call.name,
      callId: call.callId,
      status: call.status,
      ...(call.value === undefined ? {} : { value: call.value }),
      ...(call.error === undefined ? {} : { error: { code: call.error.code, message: call.error.message } }),
    })),
  };
}

function pluginInfo(plugins: readonly PluginInspection[]) {
  return plugins.map(({ id, scope, config }) => ({ id, scope, config }));
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > 24_000) throw new ApiError(413, "请求内容过大。");
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "请求内容不是有效 JSON。");
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function emitSse(response: ServerResponse, event: StreamEvent) {
  if (!response.destroyed && response.writable) response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function createToolset() {
  return [clockTool, calculatorTool];
}

async function createRuntime(input: z.infer<typeof sessionInput>): Promise<SessionRuntime> {
  const endpoint = new URL(input.baseURL);
  if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password)
    throw new ApiError(400, "Base URL 必须是没有内嵌凭据的 HTTP 或 HTTPS 地址。");
  if (sessions.size >= SESSION_LIMIT) throw new ApiError(429, "本地 Runtime 数量已达上限，请先释放旧 Runtime。");

  const id = randomUUID();
  let runtime: SessionRuntime | undefined;
  const namespace = namespaceFor(id);
  const observer = {
    observe(event: AgentEvent) {
      runtime?.emit?.({ type: "agent.event", event });
    },
  };
  const kernel = await createAgentKernel({
    maxConcurrentRuns: 2,
    maxSessions: 2,
    defaultTimeoutMs: RUN_TIMEOUT_MS,
    cancellationGraceMs: 1_000,
    onDiagnostic(error) {
      runtime?.emit?.({ type: "runtime.diagnostic", code: error.code });
    },
    configure: async (context) => {
      await context.plugin(
        aiSdkModelPlugin({
          models: [
            {
              id: "demo-model",
              protocol: "openai-chat",
              baseURL: input.baseURL,
              apiKey: input.apiKey,
              model: input.model,
              contextWindow: 32_768,
              maxOutputTokens: 2_048,
            },
          ],
          defaultModel: "demo-model",
          maxConcurrentRequests: 2,
        }),
      );
      await context.plugin(memoryTaskQueuePlugin({ maxPending: 128, agingMs: 1_000 }));
      await context.plugin(memoryTaskStorePlugin({ maxTasks: 1_024, completedTtlMs: 15 * 60_000 }));
      await context.plugin(
        taskEnginePlugin({
          maxConcurrentTasks: 2,
          maxConcurrentPerKey: 1,
          maxNodesPerFlow: 4,
          retry: { baseDelayMs: 100, maxDelayMs: 1_000, jitter: false },
        }),
      );
      await context.plugin(agentTaskPlugin());
      await context.plugin(memorySessionPlugin());
      await context.plugin(contextPlugin());
      await context.plugin(toolRuntimePlugin({ maxParallelReads: 2, maxParallelWrites: 1 }));
      await context.plugin(basicLoopPlugin({ maxSteps: 8, maxToolCalls: 8 }));
      await context.plugin(telemetryPlugin({ maxEvents: 512, observers: [observer] }));
    },
  });

  try {
    const tools = createToolset();
    await kernel.createAgent({
      namespace,
      sessionId: "primary",
      systemPrompt:
        "You are a helpful assistant in a local Harness demo. Answer in the user's language. Use get_beijing_time for current Beijing time and calculate for arithmetic; never guess tool results.",
      tools,
      allowedTools: tools.map((tool) => tool.name),
      model: "demo-model",
    });
    await kernel.createAgent({
      namespace,
      sessionId: "review",
      systemPrompt:
        "You are the review step in a two-node Harness Flow. The user message is a draft answer from another agent. Improve it for correctness, clarity, and concision. Return the revised answer directly, without describing the review process.",
      tools,
      allowedTools: tools.map((tool) => tool.name),
      model: "demo-model",
    });
  } catch (error) {
    await kernel.dispose();
    throw error;
  }

  runtime = { id, provider: input.provider, model: input.model, kernel, running: false, emit: undefined };
  sessions.set(id, runtime);
  return runtime;
}

function responseEmitter(runtime: SessionRuntime, response: ServerResponse) {
  const emit = (event: StreamEvent) => emitSse(response, event);
  runtime.emit = emit;
  return () => {
    if (runtime.emit === emit) runtime.emit = undefined;
  };
}

function makeTaskSpec(runtime: SessionRuntime, sessionId: string, text: string) {
  return {
    kind: "agent.send",
    version: 1,
    namespace: namespaceFor(runtime.id),
    input: { namespace: namespaceFor(runtime.id), sessionId, text },
    deadlineAt: Date.now() + RUN_TIMEOUT_MS,
    maxAttempts: 1,
  } as const;
}

function sumUsage(values: Array<{ inputTokens: number | null; outputTokens: number | null } | undefined>) {
  const present = values.filter((value): value is NonNullable<typeof value> => value !== undefined);
  return {
    inputTokens: present.some((value) => value.inputTokens !== null)
      ? present.reduce((sum, value) => sum + (value.inputTokens ?? 0), 0)
      : null,
    outputTokens: present.some((value) => value.outputTokens !== null)
      ? present.reduce((sum, value) => sum + (value.outputTokens ?? 0), 0)
      : null,
  };
}

function stageResult(result: TaskResult | undefined) {
  if (!result || result.status !== "succeeded") return { status: result?.status ?? "missing" };
  const response = publicRun(result.output);
  return { status: result.status, ...(response ? { text: response.text } : {}) };
}

async function runRequest(
  runtime: SessionRuntime,
  response: ServerResponse,
  input: z.infer<typeof runInput>,
): Promise<void> {
  if (runtime.running) throw new ApiError(409, "当前 Runtime 已有任务正在运行。");
  runtime.running = true;
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  const clearEmitter = responseEmitter(runtime, response);
  let cancel: (() => void) | undefined;
  let disconnected = false;
  response.once("close", () => {
    if (!response.writableEnded) {
      disconnected = true;
      cancel?.();
    }
  });
  const emit = (event: StreamEvent) => {
    if (!disconnected) emitSse(response, event);
  };
  try {
    emit({ type: "request.accepted", mode: input.mode });
    if (input.mode === "task") {
      const task = runtime.kernel.tasks.submit(makeTaskSpec(runtime, "primary", input.text));
      cancel = () => task.cancel("Client disconnected");
      emit({ type: "task.accepted", taskId: task.taskId });
      const eventPump = (async () => {
        for await (const event of task.events()) emit({ type: "task.event", event });
      })();
      const result = await task.result();
      await eventPump;
      const run = publicRun(result.output);
      if (result.status === "succeeded" && run)
        emit({ type: "run.completed", result: { status: result.status, ...run, stages: [] } });
      else
        emit({
          type: "run.failed",
          error: result.error ?? { code: result.status.toUpperCase(), message: "Agent Task 没有成功完成。" },
        });
    } else {
      const flow = runtime.kernel.tasks.submitFlow({
        nodes: [
          { id: "draft", task: makeTaskSpec(runtime, "primary", input.text) },
          {
            id: "review",
            dependsOn: ["draft"],
            inputBindings: { text: { nodeId: "draft", path: ["text"] } },
            task: makeTaskSpec(runtime, "review", ""),
          },
        ],
        outputNode: "review",
        deadlineAt: Date.now() + RUN_TIMEOUT_MS,
        maxConcurrency: 1,
        failurePolicy: "fail-fast",
      });
      cancel = () => flow.cancel();
      emit({ type: "flow.accepted", flowId: flow.flowId, nodes: ["draft", "review"] });
      const result: FlowResult = await flow.result();
      const draft = result.nodes.draft;
      const review = result.nodes.review;
      if (result.status !== "succeeded") {
        const failed = Object.values(result.nodes).find(
          (node) => node.status === "failed" || node.status === "timed_out",
        );
        emit({
          type: "run.failed",
          error: failed?.error ?? { code: result.status.toUpperCase(), message: "Flow 没有成功完成。" },
        });
        emit({
          type: "flow.completed",
          flowId: flow.flowId,
          status: result.status,
          nodes: Object.fromEntries(Object.entries(result.nodes).map(([name, node]) => [name, node.status])),
        });
      } else {
        const final = publicRun(result.output);
        const draftOutput = publicRun(draft?.output);
        const reviewOutput = publicRun(review?.output);
        if (!final)
          emit({
            type: "run.failed",
            error: { code: "INVALID_FLOW_OUTPUT", message: "Flow 输出不是有效的 Agent 结果。" },
          });
        else {
          emit({
            type: "run.completed",
            result: {
              status: result.status,
              ...final,
              usage: sumUsage([draftOutput?.usage, reviewOutput?.usage]),
              stages: [
                { id: "draft", ...stageResult(draft) },
                { id: "review", ...stageResult(review) },
              ],
            },
          });
          emit({
            type: "flow.completed",
            flowId: flow.flowId,
            status: result.status,
            nodes: Object.fromEntries(Object.entries(result.nodes).map(([name, node]) => [name, node.status])),
          });
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError && !response.headersSent) {
      json(response, error.status, { error: error.message });
      return;
    }
    if (!disconnected) {
      emit({
        type: "run.failed",
        error: { code: "HARNESS_REQUEST_FAILED", message: "Harness 无法接受或完成这次运行。" },
      });
    }
  } finally {
    clearEmitter();
    runtime.running = false;
    if (!response.writableEnded && !response.destroyed) response.end();
  }
}

async function handleApi(request: IncomingMessage, response: ServerResponse, next: (error?: Error) => void) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    next();
    return;
  }
  try {
    if (url.pathname === "/api/sessions" && request.method === "POST") {
      const parsed = sessionInput.safeParse(await readJson(request));
      if (!parsed.success) throw new ApiError(400, "供应商配置不完整或格式无效。");
      const runtime = await createRuntime(parsed.data);
      json(response, 201, {
        id: runtime.id,
        provider: runtime.provider,
        model: runtime.model,
        plugins: pluginInfo(runtime.kernel.inspectPlugins()),
      });
      return;
    }

    const match = /^\/api\/sessions\/([^/]+)(\/runs)?$/.exec(url.pathname);
    if (!match) throw new ApiError(404, "未找到这个本地 API 路由。");
    const id = decodeURIComponent(match[1] ?? "");
    const runtime = sessions.get(id);
    if (!runtime) throw new ApiError(404, "Runtime 不存在或已经释放，请重新连接模型。");
    if (match[2] === "/runs" && request.method === "POST") {
      const parsed = runInput.safeParse(await readJson(request));
      if (!parsed.success) throw new ApiError(400, "消息内容或运行模式无效。");
      await runRequest(runtime, response, parsed.data);
      return;
    }
    if (!match[2] && request.method === "DELETE") {
      sessions.delete(id);
      await runtime.kernel.dispose();
      json(response, 200, { ok: true });
      return;
    }
    throw new ApiError(405, "不支持的请求方法。");
  } catch (error) {
    if (response.headersSent || response.destroyed) {
      if (!response.writableEnded) response.end();
      return;
    }
    const status = error instanceof ApiError ? error.status : 500;
    const message = error instanceof ApiError ? error.message : "Harness Runtime 创建失败；请检查本地配置。";
    json(response, status, { error: message });
  }
}

function disposeSessions() {
  const active = [...sessions.values()];
  sessions.clear();
  for (const runtime of active) void runtime.kernel.dispose();
}

export function harnessApiPlugin(): Plugin {
  return {
    name: "nova-harness-demo-api",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        void handleApi(request, response, next).catch(() => {
          if (!response.headersSent) json(response, 500, { error: "本地 Harness API 发生错误。" });
          else response.end();
        });
      });
      server.httpServer?.once("close", disposeSessions);
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use((request, response, next) => {
        void handleApi(request, response, next).catch(() => {
          if (!response.headersSent) json(response, 500, { error: "本地 Harness API 发生错误。" });
          else response.end();
        });
      });
      server.httpServer.once("close", disposeSessions);
    },
  };
}
