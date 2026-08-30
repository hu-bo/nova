// §2 createAgent —— 唯一公开面。状态唯一 owner：本闭包；loop 经 LoopHost 读写。
import type { ModelRef, ThinkingLevel, Usage } from "@nova/model-adapters";
import type {
  Agent,
  AgentConfig,
  ContextUsage,
  AgentEvent,
  AgentState,
  AgentTool,
  Block,
  ContentPart,
  Message,
  Risk,
  RunResult,
  Todo,
  TodoState,
  ToolCall,
} from "./types.js";
import { entry, type Entry, type EntryId, type EntryParts } from "./session/entry.js";
import { record, type Record, type RecordParts } from "./session/record.js";
import { branchView } from "./session/tree.js";
import { createQueues } from "./queue/queues.js";
import { assembleSystem } from "./prompts/system.js";
import { toTodoState } from "./context/todo.js";
import type { CompactionPlan, CompactionResult } from "./context/compaction.js";
import { compactNow, newMessage, runTurnLoop, type LoopHost } from "./loop/loop.js";
import { createSubAgentGate, spawnAgentTool, type SpawnedRun, type SubAgentGate } from "./sub-agent/spawn-agent.js";
import { submitResultTool } from "./sub-agent/submit-result.js";
import { askUserTool } from "./decision/ask-user.js";
import {
  approvalMode,
  askQuestion,
  requestApproval,
  requestDecision,
  type ApprovalOutcome,
  type DecisionDeps,
} from "./decision/decision.js";

type RecordOf<K extends Record["kind"]> = Extract<Record, { kind: K }>;

// 内部装配参数：fork / 子 agent 复用同一 createAgent，不新增公开构造面
interface AgentInit {
  sessionId?: string;
  leafId?: EntryId | null;
  depth?: number;
  gate?: SubAgentGate;
}

let sessionCounter = 0;
function newSessionId(): string {
  sessionCounter += 1;
  return `session-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}

let runCounter = 0;
function newRunId(): string {
  runCounter += 1;
  return `run-${Date.now().toString(36)}-${runCounter.toString(36)}`;
}

export function createAgent(config: AgentConfig, init?: AgentInit): Agent {
  // init 优先（fork / 子 agent 内部装配），其次 config（resume / 重建），最后新建
  const sessionId = init?.sessionId ?? config.sessionId ?? newSessionId();
  const depth = init?.depth ?? 0;
  const maxDepth = config.subAgent?.maxDepth ?? 1;
  const gate = init?.gate ?? createSubAgentGate(config.subAgent?.maxConcurrent ?? 4);
  const userId = config.userId ?? "local";

  const tools = new Map<string, AgentTool>();
  for (const tool of config.tools) tools.set(tool.name, tool);

  const state: AgentState = {
    isStreaming: false,
    streamingMessage: null,
    pendingToolCalls: [],
    pendingDecision: null,
    model: config.model.model,
    thinkingLevel: "off",
    activeTools: [],
    errorMessage: null,
  };

  let view: Entry[] = [];
  let leaf: EntryId | null = init?.leafId ?? null;
  let loaded = false;
  let todos: TodoState | null = null;
  let lastUsage: Usage | null = null;
  let runUsage: Usage = { input: 0, output: 0 };
  let modelRef: ModelRef = { ...config.model };
  let runId = "idle";
  let runController = new AbortController();
  let busy = false;
  let activeRun: Promise<RunResult> | null = null;
  const allowlist = new Set<string>(); // §6 allow_always：session 级，第一版不跨 session 持久化
  const listeners = new Set<(event: AgentEvent) => void>();
  const queues = createQueues(sessionId, config.storage, () => runId);

  function emit(event: AgentEvent): void {
    if (event.type === "decision.requested") state.pendingDecision = event.request;
    else if (event.type === "decision.resolved") state.pendingDecision = null;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // listener 只是观察者；一个观察者失败不能中断其它观察者或 Agent Loop。
      }
    }
  }

  async function rec(parts: RecordParts): Promise<void> {
    await config.storage.appendRecord(sessionId, record(runId, parts));
  }

  async function append(parts: EntryParts): Promise<Entry> {
    const next = entry({ ...parts, parentId: leaf });
    await config.storage.appendEntry(sessionId, next);
    view.push(next);
    leaf = next.id;
    return next;
  }

  async function applyCompaction(plan: CompactionPlan): Promise<void> {
    const marker = entry({
      kind: "compaction",
      summary: plan.summary,
      replacedFrom: plan.replacedFrom,
      replacedTo: plan.replacedTo,
      parentId: leaf,
    });
    await config.storage.appendEntry(sessionId, marker);
    // 内存视图按 cut point 直接折叠；branchView 负责从存储重载时的折叠
    view = [marker, ...view.slice(plan.cutIndex)];
    leaf = marker.id;
  }

  const decisionDeps: DecisionDeps = {
    decide: config.decide,
    sessionId,
    storage: config.storage,
    runId: () => runId,
    emit,
  };

  // §4.3 hooks.beforeToolCall 只能单调收紧基础策略；异常与 abort 均 fail-closed。
  async function approveCall(
    call: ToolCall & { risk: Risk },
    signal: AbortSignal,
  ): Promise<ApprovalOutcome | "aborted"> {
    let mode = approvalMode(config.approvalPolicy, call.name, call.risk, allowlist);
    if (signal.aborted) return "aborted";
    try {
      const verdict = await config.hooks?.beforeToolCall?.(call, signal);
      if (verdict === "deny") mode = "deny";
      else if (verdict === "ask" && mode === "auto") mode = "ask";
      // allow 只表示 Hook 本身不收紧，不能把基础 ask / deny 放宽。
    } catch {
      if (signal.aborted) return "aborted";
      mode = "deny";
    }
    return requestApproval(mode, call, decisionDeps, allowlist, signal);
  }

  async function updateTodos(items: Todo[]): Promise<void> {
    todos = toTodoState(items);
    await rec({ kind: "todo-updated", items: todos.items });
    emit({ type: "todo.updated", items: todos.items });
  }

  async function applyTurnConfig(change: {
    model?: string;
    thinkingLevel?: ThinkingLevel;
    activeTools?: string[];
  }): Promise<void> {
    // §4.3：每次变更都要落 Entry，否则 fork 与 resume 会拿到错误的模型配置
    if (change.model !== undefined && change.model !== modelRef.model) {
      modelRef = { ...modelRef, model: change.model };
      state.model = change.model;
      await append({ kind: "model", model: change.model });
    }
    if (change.thinkingLevel !== undefined && change.thinkingLevel !== state.thinkingLevel) {
      state.thinkingLevel = change.thinkingLevel;
      await append({ kind: "thinking-level", level: change.thinkingLevel });
    }
    if (change.activeTools !== undefined) {
      state.activeTools = change.activeTools.filter((name) => tools.has(name));
      await append({ kind: "active-tools", tools: [...state.activeTools] });
    }
  }

  function mergeUsage(target: Usage, delta: Usage): Usage {
    return {
      input: target.input + delta.input,
      output: target.output + delta.output,
      ...(target.cacheRead !== undefined || delta.cacheRead !== undefined
        ? { cacheRead: (target.cacheRead ?? 0) + (delta.cacheRead ?? 0) }
        : {}),
      ...(target.cacheWrite !== undefined || delta.cacheWrite !== undefined
        ? { cacheWrite: (target.cacheWrite ?? 0) + (delta.cacheWrite ?? 0) }
        : {}),
    };
  }

  const host: LoopHost = {
    storage: config.storage,
    sessionId,
    stream: config.stream,
    toolCtx: config.ctx,
    tools,
    hooks: config.hooks,
    maxTurns: config.maxTurns ?? 100,
    toolConcurrency: config.toolConcurrency ?? 8,
    systemPrompt: assembleSystem(userId, config.systemPrompt),
    queues,
    runId: () => runId,
    signal: () => runController.signal,
    view: () => view,
    append,
    applyCompaction,
    modelRef: () => modelRef,
    contextWindow: () => modelRef.contextWindow ?? 128_000,
    thinkingLevel: () => state.thinkingLevel,
    activeTools: () => state.activeTools,
    applyTurnConfig,
    todos: () => todos,
    updateTodos,
    lastUsage: () => lastUsage,
    setLastUsage: (usage) => {
      lastUsage = usage;
      emit({ type: "context.updated", usage: currentContextUsage() });
    },
    addUsage: (usage) => {
      runUsage = mergeUsage(runUsage, usage);
    },
    runUsage: () => runUsage,
    emit,
    rec,
    streaming: (patch) => {
      Object.assign(state, patch);
    },
    approveCall,
  };

  // 加载已有分支（fork / resume / 重建场景）；新 session 加载结果为空，无副作用
  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    loaded = true;
    const branch = await config.storage.loadEntries(sessionId, leaf ?? undefined);
    view = branchView(branch);
    leaf = branch.length > 0 ? branch[branch.length - 1]!.id : leaf;
    // §9.1 TodoState 恢复：取最后一条 todo-updated（跨 run）
    const lastTodo = await config.storage.loadRecords(sessionId, { kind: "todo-updated", limit: 1, desc: true });
    const todoRecord = lastTodo[0];
    if (todoRecord && todoRecord.kind === "todo-updated") todos = toTodoState(todoRecord.items);
    const contextRecords = await config.storage.loadRecords(sessionId);
    const lastContextRecord = [...contextRecords]
      .reverse()
      .find((item) => item.kind === "usage" || item.kind === "context-compacted");
    lastUsage = lastContextRecord?.kind === "usage" ? lastContextRecord.usage : null;
    // 模型配置从 Entry 恢复（§4.3 变更落 Entry 的原因）
    for (const item of view) {
      if (item.kind === "model") {
        modelRef = { ...modelRef, model: item.model };
        state.model = item.model;
      } else if (item.kind === "thinking-level") state.thinkingLevel = item.level;
      else if (item.kind === "active-tools") state.activeTools = item.tools.filter((name) => tools.has(name));
    }
  }

  async function prompt(input: string | ContentPart[]): Promise<RunResult> {
    if (busy) throw new Error("agent is running");
    busy = true;
    try {
      await ensureLoaded();
      runId = newRunId();
      runController = new AbortController();
      runUsage = { input: 0, output: 0 };
      state.errorMessage = null;
      await rec({ kind: "run-started", input: typeof input === "string" ? input : "[multimodal input]" });
      const run = runTurnLoop(host, input).finally(() => {
        busy = false;
        activeRun = null;
      });
      activeRun = run;
      const result = await run;
      // §7 nextRun：当前 run 结束后触发一个新的独立 run
      const queued = queues.drain("nextRun");
      if (queued.length > 0) {
        void prompt(queued.join("\n\n")).catch((error) => {
          emit({ type: "error", code: "run_failed", message: error instanceof Error ? error.message : String(error) });
        });
      }
      return result;
    } catch (error) {
      busy = false;
      activeRun = null;
      throw error;
    }
  }

  async function abort(): Promise<void> {
    const run = activeRun;
    if (!run) return;
    await rec({ kind: "abort-requested" });
    runController.abort();
    // run 收敛到 stopReason "aborted"；真正抛出的异常由 prompt 的调用方看到
    await run.catch(() => undefined);
  }

  async function compact(opts?: { instruction?: string }): Promise<CompactionResult> {
    if (busy) throw new Error("agent is running");
    busy = true;
    try {
      await ensureLoaded();
      return await compactNow(host, "manual", new AbortController().signal, opts?.instruction);
    } finally {
      busy = false;
    }
  }

  function currentContextUsage(): ContextUsage {
    return { inputTokens: lastUsage?.input ?? null, contextWindow: host.contextWindow() };
  }

  async function contextUsage(): Promise<ContextUsage> {
    await ensureLoaded();
    return currentContextUsage();
  }

  async function fork(entryId: EntryId): Promise<Agent> {
    const branch = await config.storage.loadEntries(sessionId, entryId);
    if (branch.length === 0 || branch[branch.length - 1]!.id !== entryId)
      throw new Error(`entry not found: ${entryId}`);
    // §5.1 同 session 同树：新分支从 entryId 长出，不复制历史
    return createAgent(config, { sessionId, leafId: entryId, depth, gate });
  }

  // §5.2：读 Record 找中断的 run → 恢复 TodoState → 未完成 tool / decision 收敛 → 续跑
  async function resume(): Promise<void> {
    if (busy) throw new Error("agent is running");
    await ensureLoaded();
    const records = await config.storage.loadRecords(sessionId);
    const finishedRuns = new Set(records.filter((item) => item.kind === "run-finished").map((item) => item.runId));
    let interruptedRun: string | null = null;
    for (let i = records.length - 1; i >= 0; i -= 1) {
      const item = records[i]!;
      if (item.kind === "run-started" && !finishedRuns.has(item.runId)) {
        interruptedRun = item.runId;
        break;
      }
    }
    if (interruptedRun === null) return;

    // 未完成的 tool-started → 结果不可知，作为 error 结果喂回模型
    const finishedCalls = new Set(
      records
        .filter(
          (item): item is RecordOf<"tool-finished"> => item.kind === "tool-finished" && item.runId === interruptedRun,
        )
        .map((item) => item.callId),
    );
    const pendingCalls = records.filter(
      (item): item is RecordOf<"tool-started"> =>
        item.kind === "tool-started" && item.runId === interruptedRun && !finishedCalls.has(item.callId),
    );
    if (pendingCalls.length > 0) {
      const pendingIds = new Set(pendingCalls.map((item) => item.callId));
      const lastMessageEntry = [...view].reverse().find((item) => item.kind === "message");
      if (lastMessageEntry && lastMessageEntry.kind === "message" && lastMessageEntry.message.role === "assistant") {
        const results: Block[] = lastMessageEntry.message.blocks
          .filter(
            (block): block is Extract<Block, { type: "tool_call" }> =>
              block.type === "tool_call" && pendingIds.has(block.callId),
          )
          .map((block) => ({
            type: "tool_result",
            callId: block.callId,
            status: "error",
            content: [
              { type: "text", text: "上次运行在此中断，该工具调用的结果未知。请先核实实际状态，再决定是否重新执行。" },
            ],
          }));
        if (results.length > 0) await append({ kind: "message", message: newMessage("user", results) });
      }
    }

    // 未 resolved 的 decision → 重新发出请求，等人类
    const resumeDeps: DecisionDeps = { ...decisionDeps, runId: () => interruptedRun as string };
    const resolvedDecisions = new Set(
      records
        .filter(
          (item): item is RecordOf<"decision-resolved"> =>
            item.kind === "decision-resolved" && item.runId === interruptedRun,
        )
        .map((item) => item.decisionId),
    );
    const pendingDecisions = records.filter(
      (item): item is RecordOf<"decision-requested"> =>
        item.kind === "decision-requested" && item.runId === interruptedRun && !resolvedDecisions.has(item.decisionId),
    );
    if (pendingDecisions.length > 0) {
      const signal = new AbortController().signal;
      for (const item of pendingDecisions) await requestDecision(item.request, resumeDeps, signal);
    }

    await prompt("继续执行之前被中断的任务。请根据当前 TODO 与上下文判断接下来要做什么。");
  }

  // §10 子 agent：独立 session（共享 storage），工具集来自父的 config.tools；
  // spawn_agent 由深度控制（maxDepth 缺省 1 = 子 agent 不能再派生），ask_user 只留在父 agent
  const runChild: SpawnedRun = async (args, signal) => {
    const childSessionId = newSessionId();
    const childTools = config.tools.filter((tool) => args.tools === undefined || args.tools.includes(tool.name));
    const child = createAgent(
      { ...config, tools: childTools, hooks: undefined },
      { sessionId: childSessionId, depth: depth + 1, gate },
    );
    const onAbort = () => {
      void child.abort();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await child.prompt(args.task);
      const branch = await config.storage.loadEntries(childSessionId);
      const transcript: Message[] = branch
        .filter((item): item is Extract<Entry, { kind: "message" }> => item.kind === "message")
        .map((item) => item.message);
      const text =
        result.message?.blocks
          .filter((block): block is Extract<Block, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join("\n") ?? "";
      return {
        text,
        transcript,
        usage: result.usage,
        ...(result.output !== undefined ? { output: result.output } : {}),
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  if (depth < maxDepth)
    tools.set(
      "spawn_agent",
      spawnAgentTool(gate, runChild, () => runController.signal),
    );
  tools.set(submitResultTool.name, submitResultTool);
  tools.set(
    "ask_user",
    askUserTool(
      (question, signal) => askQuestion(question, decisionDeps, signal),
      () => runController.signal,
    ),
  );
  state.activeTools = [...tools.keys()];

  // §1.1 唯一的构造期校验：Chat 模式（ctx 缺省）不得装配需要执行环境的工具。
  // 默认沿用风险级别判断；自带执行环境的只读工具可显式声明不需要 ToolContext。
  if (!config.ctx) {
    const unsafe = [...tools.values()].find((tool) => tool.requiresContext ?? (tool.risk ?? "exec") !== "none");
    if (unsafe) throw new Error(`Chat 模式（未注入 ctx）不能装配 risk !== "none" 的工具：${unsafe.name}`);
  }

  return {
    sessionId,
    prompt,
    steer: (msg) => {
      void queues.enqueue("steering", msg);
    },
    followUp: (msg) => {
      void queues.enqueue("followUp", msg);
    },
    nextRun: (msg) => {
      void queues.enqueue("nextRun", msg);
    },
    abort,
    compact,
    contextUsage,
    fork,
    resume,
    get state(): AgentState {
      return { ...state, pendingToolCalls: [...state.pendingToolCalls], activeTools: [...state.activeTools] };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
