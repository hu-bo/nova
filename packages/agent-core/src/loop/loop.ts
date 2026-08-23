// §4.1 主流程：组装上下文 → 调模型 → 执行 tool batch → 观察 → 判定续跑。
// 状态 owner 在 agent.ts；loop 只经 LoopHost 读写，不持有任何自己的生命周期状态。
import type { ModelRef, ModelRequest, StreamFn, ThinkingLevel, Usage } from "@nova/model-adapters";
import type { AgentEvent, AgentTaskResult, AgentTool, Block, ContentPart, Message, Risk, RunResult, StopReason, Todo, TodoState, ToolCall, ToolContext } from "../types.js";
import type { Entry, EntryParts } from "../session/entry.js";
import type { RecordParts } from "../session/record.js";
import type { SessionStorage } from "../session/storage.js";
import { toMessages } from "../session/tree.js";
import type { Queues } from "../queue/queues.js";
import { renderTodoInjection } from "../context/todo.js";
import { shouldCompact } from "../context/budget.js";
import { planCompaction, type CompactionPlan, type CompactionResult, type CompactionTrigger } from "../context/compaction.js";
import { runToolBatch, type ToolOutcome } from "./tool-batch.js";
import type { AgentHooks } from "./hooks.js";
import type { ApprovalOutcome } from "../decision/decision.js";
import { toolParameters } from "../tool-schema.js";

export interface LoopHost {
  // —— 只读配置 ——
  storage: SessionStorage;
  sessionId: string;
  stream: StreamFn;
  toolCtx: ToolContext | undefined;
  tools: ReadonlyMap<string, AgentTool>;
  hooks: AgentHooks | undefined;
  maxTurns: number;
  toolConcurrency: number;
  systemPrompt: string;
  queues: Queues;
  // —— 状态归 agent 所有，loop 经这些方法读写 ——
  runId(): string;
  signal(): AbortSignal;
  view(): Entry[];
  append(parts: EntryParts): Promise<Entry>;
  applyCompaction(plan: CompactionPlan): Promise<void>;
  modelRef(): ModelRef;
  contextWindow(): number;
  thinkingLevel(): ThinkingLevel;
  activeTools(): string[];
  applyTurnConfig(change: { model?: string; thinkingLevel?: ThinkingLevel; activeTools?: string[] }): Promise<void>;
  todos(): TodoState | null;
  updateTodos(items: Todo[]): Promise<void>;
  lastUsage(): Usage | null;
  setLastUsage(usage: Usage): void;
  addUsage(usage: Usage): void;
  runUsage(): Usage;
  emit(event: AgentEvent): void;
  rec(parts: RecordParts): Promise<void>;
  streaming(patch: { isStreaming?: boolean; streamingMessage?: Message | null; pendingToolCalls?: ToolCall[]; errorMessage?: string | null }): void;
  approveCall(call: ToolCall & { risk: Risk }, signal: AbortSignal): Promise<ApprovalOutcome | "aborted">;
}

let messageCounter = 0;
export function newMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now().toString(36)}-${messageCounter.toString(36)}`;
}

export function newMessage(role: "user" | "assistant", blocks: Block[]): Message {
  return { id: newMessageId(), role, blocks, createdAt: Date.now() };
}

export async function runTurnLoop(host: LoopHost, input: string | ContentPart[]): Promise<RunResult> {
  await host.append({ kind: "message", message: newMessage("user", typeof input === "string" ? [{ type: "text", text: input }] : input) });

  let lastAssistant: Message | null = null;
  for (let turn = 0; turn < host.maxTurns; turn += 1) {
    // turn 边界：此刻历史是完整的（最后一条是 user message），abort 可以安全退出
    if (host.signal().aborted) return finish(host, "aborted", lastAssistant);

    // §8 预算：超过 contextWindow * 0.8 先压缩再组装
    if (shouldCompact(host.lastUsage(), host.contextWindow())) {
      await compactNow(host, "threshold", host.signal());
    }

    const model = host.modelRef().model;
    await host.rec({ kind: "turn-started", turn, model });

    const streamed = await streamTurn(host, assemble(host));
    if (streamed.usage) {
      host.addUsage(streamed.usage);
      host.setLastUsage(streamed.usage);
      await host.rec({ kind: "usage", model, usage: streamed.usage });
    }

    if (streamed.finish === "error" && streamed.errorCode === "context_overflow") {
      const compacted = await compactNow(host, "overflow", host.signal());
      if (compacted.replacedFrom !== null) continue;
    }

    lastAssistant = streamed.message;
    await host.append({ kind: "message", message: streamed.message });

    if (streamed.finish === "error") {
      const message = streamed.errorMessage ?? "model stream failed";
      host.streaming({ errorMessage: message });
      host.emit({ type: "error", code: "stream_error", message });
      return finish(host, "error", lastAssistant, message);
    }

    const toolCalls: ToolCall[] = streamed.message.blocks
      .filter((block): block is Extract<Block, { type: "tool_call" }> => block.type === "tool_call")
      .map(block => ({ callId: block.callId, name: block.name, args: block.args }));

    if (toolCalls.length === 0) {
      if (streamed.finish === "aborted") return finish(host, "aborted", lastAssistant);
      if (host.queues.nonEmpty("followUp")) {           // §7 排空点 B：阻止 run 结束，续跑
        await host.append({ kind: "message", message: newMessage("user", [{ type: "text", text: host.queues.drain("followUp").join("\n\n") }]) });
        continue;
      }
      return finish(host, streamed.finish === "max_tokens" ? "max_tokens" : "done", lastAssistant);
    }

    // 即使已 abort 也要走 batch：收敛出 error 结果，保证每个 tool_call 都有对应 tool_result
    const outcomes = await runBatch(host, toolCalls);
    await host.append({
      kind: "message",
      message: newMessage("user", outcomes.map((outcome): Block => ({ type: "tool_result", callId: outcome.callId, status: outcome.status, content: outcome.content }))),
    });
    host.streaming({ pendingToolCalls: [] });

    // tool 结果携带的 usage（如 sub-agent，§10 token 预算记父账）计入本 run
    for (const outcome of outcomes) if (outcome.usage) host.addUsage(outcome.usage);

    // §9.4 todo_write 是 TodoState 唯一写入点
    const todoOutcome = [...outcomes].reverse().find(outcome => outcome.name === "todo_write" && outcome.status === "ok");
    const todoItems = todoOutcome ? parseTodos(todoOutcome.details) : null;
    if (todoItems) await host.updateTodos(todoItems);

    if (host.signal().aborted || streamed.finish === "aborted") return finish(host, "aborted", lastAssistant);

    const submitted = [...outcomes].reverse().find(outcome => outcome.name === "submit_result" && outcome.status === "ok");
    const output = submitted ? parseSubmittedResult(submitted.details) : null;
    if (output) return finish(host, "terminate", lastAssistant, undefined, output);

    if (host.queues.nonEmpty("steering")) {             // §7 排空点 A：tool batch 完成后注入当前 run
      await host.append({ kind: "message", message: newMessage("user", [{ type: "text", text: host.queues.drain("steering").join("\n\n") }]) });
    }

    // §4.2：只有 batch 内每个结果都置 terminate 才提前结束
    if (outcomes.every(outcome => outcome.terminate)) return finish(host, "terminate", lastAssistant);
    if (host.hooks?.shouldStopAfterTurn?.()) return finish(host, "done", lastAssistant);

    const change = host.hooks?.prepareNextTurn?.();
    if (change) await host.applyTurnConfig(change);
  }

  return finish(host, "max_turns", lastAssistant);
}

async function finish(host: LoopHost, stopReason: StopReason, message: Message | null, errorMessage?: string, output?: AgentTaskResult): Promise<RunResult> {
  await host.rec({ kind: "run-finished", stopReason });
  host.streaming({ isStreaming: false, streamingMessage: null, pendingToolCalls: [] });
  const usage = host.runUsage();
  host.emit({ type: "run.end", runId: host.runId(), stopReason, usage });
  return {
    runId: host.runId(),
    stopReason,
    message,
    usage,
    ...(output !== undefined ? { output } : {}),
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function assemble(host: LoopHost): ModelRequest {
  const messages = toMessages(host.view());
  const injection = renderTodoInjection(host.todos());
  if (injection !== null) {
    // §9.4 注入位置紧邻最后一条 user message。例外：该 message 携带 tool_result 时放在它之后——
    // 插到前面会隔开 assistant tool_call 与 tool message 的一一对序（provider 契约）
    const note = newMessage("user", [{ type: "text", text: injection }]);
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") { lastUser = i; break; }
    }
    if (lastUser === -1 || messages[lastUser]!.blocks.some(block => block.type === "tool_result")) messages.push(note);
    else messages.splice(lastUser, 0, note);
  }
  const active = new Set(host.activeTools());
  const tools = [...host.tools.values()]
    .filter(tool => active.has(tool.name))
    .map(tool => ({ name: tool.name, description: tool.description, parameters: toolParameters(tool.schema) }));
  return { system: host.systemPrompt, messages, tools, thinking: host.thinkingLevel() };
}

interface StreamedTurn {
  message: Message;
  usage: Usage | null;
  finish: "stop" | "tool_use" | "max_tokens" | "error" | "aborted";
  errorMessage?: string;
  errorCode?: "context_overflow";
}

// reduce(stream(ctx))：边流边发 AgentEvent，把 ModelEvent 流收敛成一条 assistant Message
async function streamTurn(host: LoopHost, request: ModelRequest): Promise<StreamedTurn> {
  const messageId = newMessageId();
  const message: Message = { id: messageId, role: "assistant", blocks: [], createdAt: Date.now() };
  host.emit({ type: "message.start", messageId, role: "assistant" });
  host.streaming({ isStreaming: true, streamingMessage: message });

  const blocks: Block[] = [];
  let usage: Usage | null = null;
  let finishReason: StreamedTurn["finish"] = "stop";
  let errorMessage: string | undefined;
  let errorCode: "context_overflow" | undefined;

  try {
    for await (const event of host.stream(request, host.signal())) {
      if (event.type === "block.start") host.emit({ type: "block.start", messageId, index: event.index, blockType: event.blockType });
      else if (event.type === "block.delta") host.emit({ type: "block.delta", messageId, index: event.index, delta: event.delta });
      else if (event.type === "block.end") {
        blocks[event.index] = event.block;
        message.blocks = blocks.filter(Boolean);
        host.emit({ type: "block.end", messageId, index: event.index, block: event.block });
      } else if (event.type === "usage") usage = event.usage;
      else {
        finishReason = event.stopReason;
        errorMessage = event.errorMessage;
        errorCode = event.errorCode;
      }
    }
  } catch (error) {
    // §3.3 契约是 StreamFn 不得 throw；实现违约时防御性兜底，不炸掉事件序列
    finishReason = "error";
    errorMessage = error instanceof Error ? error.message : String(error);
  }

  message.blocks = blocks.filter(Boolean);
  host.emit({ type: "message.end", messageId, stopReason: finishReason === "error" ? "error" : finishReason === "aborted" ? "aborted" : finishReason === "max_tokens" ? "max_tokens" : "done" });
  host.streaming({ isStreaming: false, streamingMessage: null });
  return { message, usage, finish: finishReason, ...(errorMessage !== undefined ? { errorMessage } : {}), ...(errorCode !== undefined ? { errorCode } : {}) };
}

async function runBatch(host: LoopHost, toolCalls: ToolCall[]): Promise<ToolOutcome[]> {
  const signal = host.signal();
  const startedAt = new Map<string, number>();
  host.streaming({ pendingToolCalls: toolCalls });
  return runToolBatch(toolCalls, {
    tools: host.tools,
    ctx: host.toolCtx,
    concurrency: host.toolConcurrency,
    signal,
    approve: call => host.approveCall(call, signal),
    async onToolStart(call) {
      startedAt.set(call.callId, Date.now());
      await host.rec({ kind: "tool-started", callId: call.callId, name: call.name, args: call.args });
      host.emit({ type: "tool.start", callId: call.callId, name: call.name, args: call.args });
    },
    async onToolEnd(call, outcome) {
      const started = startedAt.get(call.callId);
      await host.rec({ kind: "tool-finished", callId: call.callId, status: outcome.status, durationMs: started !== undefined ? Date.now() - started : 0 });
      host.emit({ type: "tool.end", callId: call.callId, status: outcome.status, details: outcome.details });
      if (outcome.executed) await host.hooks?.afterToolCall?.(call, { status: outcome.status, content: outcome.content, details: outcome.details, terminate: outcome.terminate, ...(outcome.usage ? { usage: outcome.usage } : {}) });
    },
  });
}

// §8 压缩：选 cut point → 摘要 → 写 compaction Entry。overflow 触发点留给 provider 错误分类接入。
export async function compactNow(host: LoopHost, trigger: CompactionTrigger, signal: AbortSignal, instruction?: string): Promise<CompactionResult> {
  const plan = await planCompaction(host.view(), { stream: host.stream, signal }, instruction);
  if (!plan) return { trigger, summarized: false, replacedFrom: null, replacedTo: null };
  await host.applyCompaction(plan);
  return { trigger, summarized: plan.summarized, replacedFrom: plan.replacedFrom, replacedTo: plan.replacedTo };
}

// todo_write 已在工具侧校验过形状，这里只做防御性读取
function parseTodos(details: unknown): Todo[] | null {
  if (!details || typeof details !== "object") return null;
  const items = (details as { items?: unknown }).items;
  return Array.isArray(items) ? items as Todo[] : null;
}

function parseSubmittedResult(details: unknown): AgentTaskResult | null {
  if (!details || typeof details !== "object" || typeof (details as { ok?: unknown }).ok !== "boolean") return null;
  return details as AgentTaskResult;
}
