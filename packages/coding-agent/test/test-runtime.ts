// testing.md §3.1 —— 集成装配根。结构与 agent-server 的 Composition Root 相同：
// stream / ctx / storage / decide 四个注入点在这里接线；两处若开始分叉，说明边界漏了。
import { memoryStorage } from "@nova/agent-core";
import type {
  Agent, AgentHooks, ApprovalPolicy, Decide, DecisionRequest, Entry, ModelEvent, ModelRef, SessionStorage, StreamFn,
} from "@nova/agent-core";
import { createHarness as createAgentHarness } from "@nova/harness";
import { codingAgentModule } from "../src/index.js";
import { createRunnerSdk, toToolContext, type RunnerSdk, type RunnerSession } from "@nova/runner-sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// vitest 的 cwd 不一定是仓库根，target/debug 相对本文件解析
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const integrationRoot = fileURLToPath(new URL("./", import.meta.url));
const codingHarness = createAgentHarness({ modules: [codingAgentModule] });

// —— Runner 装配（testing.md §3.1）——
// SDK 在 loopback 随机端口监听，真实 Rust Runner 进程出站连入；
// 没有入站执行端口，没有第二条执行路径。

const testToken = "integration-test-token"; // 连接身份占位；接纳决策在 onSession

export interface RunnerHandle {
  process: ChildProcess;
  workspace: string;
  session: RunnerSession;
  sdk: RunnerSdk;
}

export async function startRunner(opts: { workspace?: string } = {}): Promise<RunnerHandle> {
  const workspace = opts.workspace ?? await mkdtemp(join(tmpdir(), "nova-it-workspace-"));
  const sdk = createRunnerSdk({});
  await sdk.listen();
  const binary = process.env.NOVA_RUNNER_BIN ?? join(repoRoot, "target", "debug", process.platform === "win32" ? "nova-runner.exe" : "nova-runner");
  const child = spawn(binary, ["--server", sdk.endpoint, "--token", testToken, "--workspace", workspace], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", chunk => { stderr += String(chunk); });
  try {
    const session = await new Promise<RunnerSession>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let offSession = () => {};
      const finish = () => {
        offSession();
        if (timer !== undefined) clearTimeout(timer);
      };
      function fail(reason: string): void {
        finish();
        reject(new Error(`nova-runner ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      }
      offSession = sdk.onSession(candidate => {
        finish();
        resolve(candidate.accept());
      });
      timer = setTimeout(() => fail("did not connect within 15s"), 15_000);
      timer.unref();
      child.once("error", error => fail(`failed to start: ${error.message}`));
      child.once("exit", code => fail(`exited (${code}) before connecting`));
    });
    return { process: child, workspace, session, sdk };
  } catch (error) {
    child.kill();
    await sdk.close();
    throw error;
  }
}

// —— 录制回放（§3.2）——

let callCounter = 0;

export function toolTurn(calls: Array<{ name: string; args: unknown }>, usage?: { input: number; output: number }): ModelEvent[] {
  const events: ModelEvent[] = [];
  for (const [index, call] of calls.entries()) {
    callCounter += 1;
    events.push({ type: "block.start", index, blockType: "tool_call" });
    events.push({ type: "block.end", index, block: { type: "tool_call", callId: `c${callCounter}`, name: call.name, args: call.args } });
  }
  if (usage) events.push({ type: "usage", usage });
  events.push({ type: "finish", stopReason: "tool_use" });
  return events;
}

export function textTurn(text: string, usage?: { input: number; output: number }): ModelEvent[] {
  return [
    { type: "block.start", index: 0, blockType: "text" },
    { type: "block.end", index: 0, block: { type: "text", text } },
    ...(usage ? [{ type: "usage", usage } as ModelEvent] : []),
    { type: "finish", stopReason: "stop" },
  ];
}

export function scripted(turns: ModelEvent[][]): StreamFn {
  let turn = 0;
  return async function* (_request, signal) {
    if (signal.aborted) { yield { type: "finish", stopReason: "aborted" }; return; }
    for (const event of turns[turn++] ?? []) yield event;
  };
}

export function replay(name: string): StreamFn {
  const file = join(integrationRoot, "fixtures", `${name}.jsonl`);
  const turns = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line) as ModelEvent[]);
  return scripted(turns);
}

// 分支内所有 tool_result（按 Entry 顺序）
export function toolResults(entries: Entry[]): Array<{ status: "ok" | "error"; text: string }> {
  const results: Array<{ status: "ok" | "error"; text: string }> = [];
  for (const item of entries) {
    if (item.kind !== "message") continue;
    for (const block of item.message.blocks) {
      if (block.type === "tool_result") {
        results.push({ status: block.status, text: block.content.map(part => part.type === "text" ? part.text : "").join("") });
      }
    }
  }
  return results;
}

export function toolResultTexts(entries: Entry[]): string[] {
  return toolResults(entries).map(result => result.text);
}

// —— decide 记录（§3.1 recordingDecide）——

const defaultAnswer: Decide = async request =>
  request.kind === "approval" ? { kind: "approval", decision: "allow" } : { kind: "question", answers: ["yes"] };

// —— harness ——

export interface TestRuntimeOptions {
  stream: StreamFn;
  model?: ModelRef;
  /** 缺省全部放行；无论传什么，decisions 日志都会记录 */
  decide?: Decide;
  approvalPolicy?: ApprovalPolicy;
  sessionId?: string;
  storage?: SessionStorage;
  contextWindow?: number;
  maxTurns?: number;
  hooks?: AgentHooks;
  /** full 模式复用已有 workspace（跨进程 resume 场景）；其清理由调用方负责 */
  workspace?: string;
}

export interface TestRuntime {
  agent: Agent;
  storage: SessionStorage;
  decisions: DecisionRequest[];
  runner: RunnerHandle;
  workspace: string;
  cleanup(): Promise<void>;
}

export async function createTestRuntime(opts: TestRuntimeOptions): Promise<TestRuntime> {
  const decisions: DecisionRequest[] = [];
  const answer = opts.decide ?? defaultAnswer;
  const decide: Decide = async (request, signal) => { decisions.push(request); return answer(request, signal); };
  const storage = opts.storage ?? memoryStorage();
  const shared = {
    model: opts.model ?? { provider: "openai" as const, model: "recording", contextWindow: opts.contextWindow },
    stream: opts.stream,
    storage,
    decide,
    sessionId: opts.sessionId,
    hooks: opts.hooks,
    approvalPolicy: opts.approvalPolicy,
    maxTurns: opts.maxTurns,
  };

  const ownsWorkspace = opts.workspace === undefined;
  const runner = await startRunner(ownsWorkspace ? {} : { workspace: opts.workspace });
  const controller = new AbortController();
  const agent = codingHarness.createAgent({
    ...shared,
    ctx: toToolContext(runner.session, { cwd: runner.workspace, signal: controller.signal }),
  });
  return {
    agent,
    storage,
    decisions,
    runner,
    workspace: runner.workspace,
    cleanup: async () => {
      runner.process.kill();
      await runner.sdk.close();
      if (ownsWorkspace) await rm(runner.workspace, { recursive: true, force: true });
    },
  };
}
