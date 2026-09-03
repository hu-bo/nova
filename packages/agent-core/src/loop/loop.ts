// §4.1 主流程：组装上下文 → 调模型 → 执行 tool batch → 观察 → 判定续跑。
// 状态 owner 在 agent.ts；loop 只经 LoopHost 读写，不持有任何自己的生命周期状态。
import type { ModelRef, ModelRequest, StreamFn, ThinkingLevel, TokenEstimator, Usage } from "@nova/model-adapters";
import type {
  AgentEvent,
  AgentTaskResult,
  AgentTool,
  Block,
  ContentPart,
  Message,
  Risk,
  RunResult,
  StopReason,
  Todo,
  TodoState,
  ToolCall,
  ToolContext,
} from "../types.js";
import type { Entry, EntryParts } from "../session/entry.js";
import type { RecordParts } from "../session/record.js";
import type { SessionStorage } from "../session/storage.js";
import { toContextMessages } from "../session/tree.js";
import type { Queues } from "../queue/queues.js";
import { renderTodoInjection } from "../context/todo.js";
import { compactionTarget, maxInputTokens, shouldCompact } from "../context/budget.js";
import {
  planCompaction,
  type CompactionPlan,
  type CompactionResult,
  type CompactionTrigger,
} from "../context/compaction.js";
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
  toolTimeoutMs: number;
  systemPrompt: string;
  tokenEstimator: TokenEstimator;
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
  contextUsage(): import("../types.js").ContextUsage;
  setLastUsage(usage: Usage, estimatedInput: number): void;
  addUsage(usage: Usage): void;
  runUsage(): Usage;
  emit(event: AgentEvent): void;
  rec(parts: RecordParts): Promise<void>;
  streaming(patch: {
    isStreaming?: boolean;
    streamingMessage?: Message | null;
    pendingToolCalls?: ToolCall[];
    errorMessage?: string | null;
  }): void;
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
  await host.append({
    kind: "message",
    message: newMessage("user", typeof input === "string" ? [{ type: "text", text: input }] : input),
  });

  let lastAssistant: Message | null = null;
  for (let turn = 0; turn < host.maxTurns; turn += 1) {
    // turn 边界：此刻历史是完整的（最后一条是 user message），abort 可以安全退出
    if (host.signal().aborted) return finish(host, "aborted", lastAssistant);

    await compactToBudget(host, host.signal());

    const model = host.modelRef().model;
    await host.rec({ kind: "turn-started", turn, model });

    const request = assembleRequest(host);
    const estimatedInput = host.tokenEstimator.estimateRequest(request).tokens;
    const streamed = await streamTurn(host, request);
    if (streamed.usage) {
      host.addUsage(streamed.usage);
      host.setLastUsage(streamed.usage, estimatedInput);
      await host.rec({ kind: "usage", model, usage: streamed.usage, estimatedInput });
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

    if (streamed.finish === "repetition_detected") {
      const message = "模型输出出现重复，已停止本次回答以避免继续生成无效内容。";
      host.streaming({ errorMessage: message });
      host.emit({ type: "error", code: "repetition_detected", message });
      return finish(host, "repetition_detected", lastAssistant, message);
    }

    const toolCalls: ToolCall[] = streamed.message.blocks
      .filter((block): block is Extract<Block, { type: "tool_call" }> => block.type === "tool_call")
      .map((block) => ({ callId: block.callId, name: block.name, args: block.args }));

    if (toolCalls.length === 0) {
      if (streamed.finish === "aborted") return finish(host, "aborted", lastAssistant);
      if (host.queues.nonEmpty("followUp")) {
        // §7 排空点 B：阻止 run 结束，续跑
        await host.append({
          kind: "message",
          message: newMessage("user", [{ type: "text", text: host.queues.drain("followUp").join("\n\n") }]),
        });
        continue;
      }
      return finish(host, streamed.finish === "max_tokens" ? "max_tokens" : "done", lastAssistant);
    }

    // 即使已 abort 也要走 batch：收敛出 error 结果，保证每个 tool_call 都有对应 tool_result
    const outcomes = await runBatch(host, toolCalls);
    await host.append({
      kind: "message",
      message: newMessage(
        "user",
        outcomes.map((outcome): Block => ({
          type: "tool_result",
          callId: outcome.callId,
          status: outcome.status,
          content: outcome.content,
        })),
      ),
    });
    host.streaming({ pendingToolCalls: [] });

    // tool 结果携带的 usage（如 sub-agent，§10 token 预算记父账）计入本 run
    for (const outcome of outcomes) if (outcome.usage) host.addUsage(outcome.usage);

    // A disconnected Runner invalidates the session captured by this Agent.
    // Do not feed the same failed tool call back to the model: it would keep
    // issuing work against the dead session until maxTurns, and replaying a
    // write/exec operation could duplicate side effects. The next user retry
    // creates a runtime with the newly connected Runner session.
    const runnerUnavailable = outcomes.some(isRunnerUnavailableOutcome);
    if (runnerUnavailable) {
      const message = "Runner connection lost; the tool call was not completed. Retry after the Runner reconnects.";
      host.streaming({ errorMessage: message });
      host.emit({ type: "error", code: "RUNNER_UNAVAILABLE", message });
      return finish(host, "error", lastAssistant, message);
    }

    // §9.4 todo_write 是 TodoState 唯一写入点
    const todoOutcome = [...outcomes]
      .reverse()
      .find((outcome) => outcome.name === "todo_write" && outcome.status === "ok");
    const todoItems = todoOutcome ? parseTodos(todoOutcome.details) : null;
    if (todoItems) await host.updateTodos(todoItems);

    if (host.signal().aborted || streamed.finish === "aborted") return finish(host, "aborted", lastAssistant);

    const submitted = [...outcomes]
      .reverse()
      .find((outcome) => outcome.name === "submit_result" && outcome.status === "ok");
    const output = submitted ? parseSubmittedResult(submitted.details) : null;
    if (output) return finish(host, "terminate", lastAssistant, undefined, output);

    if (host.queues.nonEmpty("steering")) {
      // §7 排空点 A：tool batch 完成后注入当前 run
      await host.append({
        kind: "message",
        message: newMessage("user", [{ type: "text", text: host.queues.drain("steering").join("\n\n") }]),
      });
    }

    // §4.2：只有 batch 内每个结果都置 terminate 才提前结束
    if (outcomes.every((outcome) => outcome.terminate)) return finish(host, "terminate", lastAssistant);
    if (host.hooks?.shouldStopAfterTurn?.()) return finish(host, "done", lastAssistant);

    const change = host.hooks?.prepareNextTurn?.();
    if (change) await host.applyTurnConfig(change);
  }

  return finish(host, "max_turns", lastAssistant);
}

async function finish(
  host: LoopHost,
  stopReason: StopReason,
  message: Message | null,
  errorMessage?: string,
  output?: AgentTaskResult,
): Promise<RunResult> {
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

export function assembleRequest(host: LoopHost): ModelRequest {
  const messages = toContextMessages(
    host.view(),
    host.tokenEstimator,
    4_096,
    Math.max(1_024, Math.floor(maxInputTokens(host.modelRef()) * 0.5)),
  );
  const injection = renderTodoInjection(host.todos());
  if (injection !== null) {
    // §9.4 注入位置紧邻最后一条 user message。例外：该 message 携带 tool_result 时放在它之后——
    // 插到前面会隔开 assistant tool_call 与 tool message 的一一对序（provider 契约）
    const note = newMessage("user", [{ type: "text", text: injection }]);
    let lastUser = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") {
        lastUser = i;
        break;
      }
    }
    if (lastUser === -1 || messages[lastUser]!.blocks.some((block) => block.type === "tool_result"))
      messages.push(note);
    else messages.splice(lastUser, 0, note);
  }
  const active = new Set(host.activeTools());
  const tools = [...host.tools.values()]
    .filter((tool) => active.has(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: toolParameters(tool.schema) }));
  return {
    system: host.systemPrompt,
    messages,
    tools,
    thinking: host.thinkingLevel(),
    maxOutput: host.modelRef().maxOutput,
  };
}

interface StreamedTurn {
  message: Message;
  usage: Usage | null;
  finish: "stop" | "tool_use" | "max_tokens" | "repetition_detected" | "error" | "aborted";
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
  const openText = new Map<number, string>();
  const repetitionCheckpoints = new Map<number, number>();
  let usage: Usage | null = null;
  let finishReason: StreamedTurn["finish"] = "stop";
  let errorMessage: string | undefined;
  let errorCode: "context_overflow" | undefined;

  try {
    for await (const event of host.stream(request, host.signal())) {
      if (event.type === "block.start") {
        if (event.blockType === "text") openText.set(event.index, "");
        host.emit({ type: "block.start", messageId, index: event.index, blockType: event.blockType });
      } else if (event.type === "block.delta") {
        const text = openText.get(event.index);
        if (text !== undefined) {
          const next = text + event.delta;
          openText.set(event.index, next);
          const checkpoint = repetitionCheckpoints.get(event.index) ?? 0;
          if (next.length - checkpoint >= 128 && hasRepeatedTail(next)) {
            const block: Block = { type: "text", text: next };
            blocks[event.index] = block;
            host.emit({ type: "block.delta", messageId, index: event.index, delta: event.delta });
            host.emit({ type: "block.end", messageId, index: event.index, block });
            finishReason = "repetition_detected";
            break;
          }
          repetitionCheckpoints.set(event.index, next.length);
        }
        host.emit({ type: "block.delta", messageId, index: event.index, delta: event.delta });
      } else if (event.type === "block.end") {
        openText.delete(event.index);
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
  host.emit({
    type: "message.end",
    messageId,
    stopReason:
      finishReason === "error"
        ? "error"
        : finishReason === "aborted"
          ? "aborted"
          : finishReason === "max_tokens"
            ? "max_tokens"
            : finishReason === "repetition_detected"
              ? "repetition_detected"
              : "done",
  });
  host.streaming({ isStreaming: false, streamingMessage: null });
  return {
    message,
    usage,
    finish: finishReason,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

// 只截断明显退化：同一段至少 160 个字符连续出现三次。短语复用、代码中的重复行不触发。
function hasRepeatedTail(text: string): boolean {
  const maxUnit = Math.min(1024, Math.floor(text.length / 3));
  for (let size = 160; size <= maxUnit; size += 1) {
    const tail = text.slice(-size);
    if (text.slice(-size * 2, -size) === tail && text.slice(-size * 3, -size * 2) === tail) return true;
  }
  return false;
}

async function runBatch(host: LoopHost, toolCalls: ToolCall[]): Promise<ToolOutcome[]> {
  const signal = host.signal();
  const startedAt = new Map<string, number>();
  host.streaming({ pendingToolCalls: toolCalls });
  return runToolBatch(toolCalls, {
    tools: host.tools,
    ctx: host.toolCtx,
    concurrency: host.toolConcurrency,
    timeoutMs: host.toolTimeoutMs,
    signal,
    approve: (call) => host.approveCall(call, signal),
    async onToolStart(call) {
      startedAt.set(call.callId, Date.now());
      await host.rec({ kind: "tool-started", callId: call.callId, name: call.name, args: call.args });
      host.emit({ type: "tool.start", callId: call.callId, name: call.name, args: call.args });
    },
    async onToolEnd(call, outcome) {
      const started = startedAt.get(call.callId);
      if (started !== undefined)
        await host.rec({
          kind: "tool-finished",
          callId: call.callId,
          status: outcome.status,
          durationMs: Date.now() - started,
        });
      host.emit({ type: "tool.end", callId: call.callId, status: outcome.status, details: outcome.details });
      if (outcome.executed)
        await host.hooks?.afterToolCall?.(call, {
          status: outcome.status,
          content: outcome.content,
          details: outcome.details,
          terminate: outcome.terminate,
          ...(outcome.usage ? { usage: outcome.usage } : {}),
        });
    },
  });
}

function isRunnerUnavailableOutcome(outcome: ToolOutcome): boolean {
  if (outcome.status !== "error") return false;
  const details = outcome.details;
  const detailMessage =
    details !== null && typeof details === "object" && "message" in details
      ? String((details as { message?: unknown }).message)
      : "";
  return (
    (details !== null &&
      typeof details === "object" &&
      "code" in details &&
      (details as { code?: unknown }).code === "RUNNER_UNAVAILABLE") ||
    detailMessage === "runner connection lost" ||
    outcome.content.some(
      (part) =>
        part.type === "text" &&
        (part.text.includes("RUNNER_UNAVAILABLE") || part.text.includes("runner connection lost")),
    )
  );
}

// §8 压缩：选 cut point → 摘要 → 写 compaction Entry。overflow 触发点留给 provider 错误分类接入。
export async function compactNow(
  host: LoopHost,
  trigger: CompactionTrigger,
  signal: AbortSignal,
  instruction?: string,
): Promise<CompactionResult> {
  const plan = await planCompaction(
    host.view(),
    { stream: host.stream, signal, estimator: host.tokenEstimator, maxInputTokens: maxInputTokens(host.modelRef()) },
    instruction,
  );
  if (!plan) return { trigger, summarized: false, replacedFrom: null, replacedTo: null };
  await host.applyCompaction(plan);
  await host.rec({ kind: "context-compacted", trigger, summarized: plan.summarized });
  return { trigger, summarized: plan.summarized, replacedFrom: plan.replacedFrom, replacedTo: plan.replacedTo };
}

async function compactToBudget(host: LoopHost, signal: AbortSignal): Promise<void> {
  const inputLimit = maxInputTokens(host.modelRef());
  if (!shouldCompact(host.contextUsage().estimatedInputTokens, inputLimit)) return;
  const target = compactionTarget(inputLimit);
  const maxAttempts = Math.max(1, host.view().length);
  for (let attempt = 0; attempt < maxAttempts && host.contextUsage().estimatedInputTokens > target; attempt += 1) {
    const compacted = await compactNow(host, "threshold", signal);
    if (compacted.replacedFrom === null) break;
  }
}

// todo_write 已在工具侧校验过形状，这里只做防御性读取
function parseTodos(details: unknown): Todo[] | null {
  if (!details || typeof details !== "object") return null;
  const items = (details as { items?: unknown }).items;
  return Array.isArray(items) ? (items as Todo[]) : null;
}

function parseSubmittedResult(details: unknown): AgentTaskResult | null {
  if (!details || typeof details !== "object" || typeof (details as { ok?: unknown }).ok !== "boolean") return null;
  return details as AgentTaskResult;
}
