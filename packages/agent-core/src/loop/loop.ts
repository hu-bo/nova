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
import { toContextMessages, toMessages } from "../session/tree.js";
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

import type { RunCheckpoint } from "../session/checkpoint.js";

export interface LoopHost {
  checkpoint(): RunCheckpoint | null;
  saveCheckpoint(patch: Partial<RunCheckpoint>): Promise<void>;
  pauseReason(): string | null;
  pauseRun(reason: string): void;
  modelTimeoutMs: number;
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
  append(parts: EntryParts, patch?: Partial<RunCheckpoint>): Promise<Entry>;
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

export async function runTurnLoop(host: LoopHost, input?: string | ContentPart[], resume = false): Promise<RunResult> {
  if (input !== undefined)
    await host.append({
      kind: "message",
      message: newMessage("user", typeof input === "string" ? [{ type: "text", text: input }] : input),
    });

  let lastAssistant: Message | null = null;
  const resumedMessage = resume
    ? [...host.view()].reverse().find((e) => e.kind === "message" && e.message.role === "assistant")
    : undefined;
  let pending =
    host.checkpoint()?.phase === "tools" && resumedMessage?.kind === "message" ? resumedMessage.message : null;
  if (resume && host.checkpoint()?.phase === "finish") {
    if (host.queues.nonEmpty("followUp")) {
      await host.append({ kind: "message", message: newMessage("user", host.queues.drain("followUp")) });
    } else {
      return finish(
        host,
        host.checkpoint()?.completion ?? "done",
        resumedMessage?.kind === "message" ? resumedMessage.message : null,
      );
    }
  }
  for (let turn = Math.max(0, (host.checkpoint()?.turns ?? 0) - (pending ? 1 : 0)); turn < host.maxTurns; turn += 1) {
    // turn 边界：此刻历史是完整的（最后一条是 user message），abort 可以安全退出
    if (host.signal().aborted) return finish(host, "aborted", lastAssistant);

    const modalities = host.modelRef().inputModalities;
    if (
      modalities &&
      !modalities.includes("image") &&
      toMessages(host.view()).some((message) =>
        message.blocks.some(
          (block) =>
            block.type === "image" ||
            (block.type === "tool_result" && block.content.some((part) => part.type === "image")),
        ),
      )
    ) {
      const message = "当前上下文包含图片，请选择支持图片的模型或清空上下文";
      host.streaming({ errorMessage: message });
      host.emit({ type: "error", code: "unsupported_input", message });
      return finish(host, "error", lastAssistant, message);
    }
    await compactToBudget(host, host.signal());

    let streamed: StreamedTurn;
    if (pending) {
      streamed = { message: pending, usage: null, finish: "tool_use" };
      pending = null;
    } else {
      const model = host.modelRef().model;
      await host.rec({ kind: "turn-started", turn, model });

      const request = assembleRequest(host);
      const estimatedInput = host.tokenEstimator.estimateRequest(request).tokens;
      streamed = await streamTurn(host, request);
      if (streamed.usage) {
        host.addUsage(streamed.usage);
        host.setLastUsage(streamed.usage, estimatedInput);
        await host.rec({ kind: "usage", model, usage: streamed.usage, estimatedInput });
      }

      if (streamed.finish === "error" && streamed.errorCode === "context_overflow") {
        const compacted = await compactNow(host, "overflow", host.signal());
        if (compacted.replacedFrom !== null) continue;
      }

      if (host.pauseReason()) return finish(host, "paused", streamed.message);
      await host.append(
        { kind: "message", message: streamed.message },
        { completion: streamed.finish === "stop" || streamed.finish === "tool_use" ? "done" : streamed.finish },
      );
    }
    lastAssistant = streamed.message;

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
          message: newMessage("user", host.queues.drain("followUp")),
        });
        continue;
      }
      return finish(host, streamed.finish === "max_tokens" ? "max_tokens" : "done", lastAssistant);
    }

    // 即使已 abort 也要走 batch：收敛出 error 结果，保证每个 tool_call 都有对应 tool_result
    const outcomes = await runBatch(host, toolCalls);
    const runnerUnavailable = outcomes.some(isRunnerUnavailableOutcome);
    if (runnerUnavailable) host.pauseRun("outcome_unknown");
    if (host.pauseReason()) {
      const message =
        host.pauseReason() === "outcome_unknown"
          ? runnerUnavailable
            ? "Runner connection lost; the tool result is unknown. Verify the actual state before repeating the operation."
            : "Tool execution result is unknown. Verify the actual state before repeating the operation."
          : undefined;
      if (message) {
        host.streaming({ errorMessage: message });
        host.emit({ type: "error", code: runnerUnavailable ? "RUNNER_UNAVAILABLE" : "outcome_unknown", message });
      }
      return finish(host, "paused", lastAssistant, message);
    }

    // §9.4 todo_write 是 TodoState 唯一写入点
    const todoOutcome = [...outcomes]
      .reverse()
      .find((outcome) => outcome.name === "todo_write" && outcome.status === "ok");
    const todoItems = todoOutcome ? parseTodos(todoOutcome.details) : null;
    if (todoItems) await host.updateTodos(todoItems);
    const submitted = [...outcomes]
      .reverse()
      .find((outcome) => outcome.name === "submit_result" && outcome.status === "ok");
    const output = submitted ? parseSubmittedResult(submitted.details) : null;
    const terminate = !!output || outcomes.every((outcome) => outcome.terminate);
    await host.append(
      {
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
      },
      terminate ? { phase: "finish", completion: "terminate" } : {},
    );
    host.streaming({ pendingToolCalls: [] });

    if (host.signal().aborted || streamed.finish === "aborted") return finish(host, "aborted", lastAssistant);
    if (output) return finish(host, "terminate", lastAssistant, undefined, output);

    if (host.queues.nonEmpty("steering")) {
      // §7 排空点 A：tool batch 完成后注入当前 run
      await host.append(
        {
          kind: "message",
          message: newMessage("user", host.queues.drain("steering")),
        },
        terminate ? { phase: "finish", completion: "terminate" } : {},
      );
    }

    // §4.2：只有 batch 内每个结果都置 terminate 才提前结束
    if (terminate) return finish(host, "terminate", lastAssistant);
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
  if (host.pauseReason()) stopReason = host.pauseReason() === "deadline_exceeded" ? "error" : "paused";
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
  const openTypes = new Map<number, "text" | "thinking">();
  const repetitionCheckpoints = new Map<number, number>();
  let usage: Usage | null = null;
  let finishReason: StreamedTurn["finish"] = "stop";
  let sawFinish = false;
  let errorMessage: string | undefined;
  let errorCode: "context_overflow" | undefined;

  const controller = new AbortController();
  const signal = AbortSignal.any([host.signal(), controller.signal]);
  const timeout = setTimeout(() => controller.abort(new Error("Model request deadline exceeded")), host.modelTimeoutMs);
  const iterator = host.stream(request, signal)[Symbol.asyncIterator]();
  let lastSaved = Date.now();
  let dirtyBytes = 0;
  const snapshot = () => {
    const draft = [...blocks];
    for (const [index, text] of openText) draft[index] = { type: openTypes.get(index) ?? "text", text };
    return { ...message, blocks: draft.filter(Boolean) };
  };
  try {
    let next = iterator.next();
    for (;;) {
      const item = await nextOrTick(next, signal);
      if (dirtyBytes && (Date.now() - lastSaved >= 1000 || dirtyBytes >= 4096)) {
        await host.saveCheckpoint({ draft: snapshot() });
        lastSaved = Date.now();
        dirtyBytes = 0;
      }
      if (!item) continue;
      if (item.done) {
        if (!sawFinish) {
          finishReason = "error";
          errorMessage = "Model stream ended without a finish event";
        }
        break;
      }
      const event = item.value;
      next = iterator.next();
      if (event.type === "block.start") {
        if (event.blockType === "text" || event.blockType === "thinking") {
          openText.set(event.index, "");
          openTypes.set(event.index, event.blockType);
        }
        host.emit({ type: "block.start", messageId, index: event.index, blockType: event.blockType });
      } else if (event.type === "block.delta") {
        dirtyBytes += event.delta.length;
        const text = openText.get(event.index);
        if (text !== undefined) {
          const next = text + event.delta;
          openText.set(event.index, next);
          const checkpoint = repetitionCheckpoints.get(event.index) ?? 0;
          if (openTypes.get(event.index) === "text" && next.length - checkpoint >= 128 && hasRepeatedTail(next)) {
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
        sawFinish = true;
        finishReason = event.stopReason;
        errorMessage = event.errorMessage;
        errorCode = event.errorCode;
      }
    }
  } catch (error) {
    if (host.signal().aborted) finishReason = "aborted";
    else finishReason = "error";
    // §3.3 契约是 StreamFn 不得 throw；实现违约时防御性兜底，不炸掉事件序列
    errorMessage = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    void iterator.return?.().catch(() => undefined);
  }

  message.blocks = snapshot().blocks;
  await host.saveCheckpoint({ draft: message });
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
  host.streaming({ streamingMessage: null });
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
  const facts = await host.storage.loadRecords(host.sessionId, { runId: host.runId() });
  const completed = new Map(
    facts
      .filter((r) => r.kind === "tool-finished" && r.content !== undefined && r.outcomeKnown !== false)
      .map((r) => [r.kind === "tool-finished" ? r.callId : "", r]),
  );
  const started = new Set(
    facts.filter((r) => r.kind === "tool-started").map((r) => (r.kind === "tool-started" ? r.callId : "")),
  );
  if (toolCalls.some((c) => started.has(c.callId) && !completed.has(c.callId))) {
    host.pauseRun("outcome_unknown");
    return [];
  }
  const remaining = toolCalls.filter((c) => !completed.has(c.callId));
  for (const call of remaining) {
    const matching = facts.filter(
      (r) => r.kind === "tool-started" && r.name === call.name && stableJson(r.args) === stableJson(call.args),
    );
    if (matching.length >= 3) {
      const results = matching.map((r) => (r.kind === "tool-started" ? completed.get(r.callId) : undefined));
      if (
        results.every((r) => r?.kind === "tool-finished") &&
        new Set(results.map((r) => (r?.kind === "tool-finished" ? stableJson([r.status, r.content]) : ""))).size === 1
      ) {
        host.pauseRun("no_progress");
        return [];
      }
    }
  }
  const startedAt = new Map<string, number>();
  host.streaming({ pendingToolCalls: toolCalls });
  const outcomes = await runToolBatch(remaining, {
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
      if (!outcome.executed && signal.aborted) return;
      const started = startedAt.get(call.callId);
      const outcomeKnown =
        outcome.outcomeKnown !== false &&
        !(outcome.executed && outcome.status === "error" && (signal.aborted || isRunnerUnavailableOutcome(outcome)));
      if (outcome.usage) host.addUsage(outcome.usage);
      await host.rec({
        kind: "tool-finished",
        callId: call.callId,
        status: outcome.status,
        durationMs: started === undefined ? 0 : Date.now() - started,
        content: outcome.content,
        details: outcome.details,
        executed: outcome.executed,
        outcomeKnown,
        terminate: outcome.terminate,
        ...(outcome.usage ? { usage: outcome.usage } : {}),
      });
      host.emit({ type: "tool.end", callId: call.callId, status: outcome.status, details: outcome.details });
      if (!outcomeKnown && !signal.aborted) host.pauseRun("outcome_unknown");
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
  return toolCalls.map((call) => {
    const saved = completed.get(call.callId);
    if (saved?.kind === "tool-finished")
      return {
        callId: call.callId,
        name: call.name,
        status: saved.status,
        content: saved.content!,
        details: saved.details,
        executed: saved.executed ?? true,
        terminate: saved.terminate ?? false,
        ...(saved.usage ? { usage: saved.usage } : {}),
      };
    return outcomes.find((o) => o.callId === call.callId)!;
  });
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );
}

function nextOrTick<T>(next: Promise<IteratorResult<T>>, signal: AbortSignal): Promise<IteratorResult<T> | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new Error("Interrupted"));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, 1000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    next.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
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
  host.emit({ type: "context.compacted", trigger, summarized: plan.summarized });
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
