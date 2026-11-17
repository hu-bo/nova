import { randomUUID } from "node:crypto";
import type { AgentExecutor, RunExecution, SessionDefinition } from "../../contracts/agent.js";
import type { ContextBuilder, ContextCompactor } from "../../contracts/context.js";
import type { ModelAdapter, ModelChunk } from "../../contracts/model.js";
import type { AgentMessage, JsonValue } from "../../contracts/message.js";
import type { BudgetReason, RunResult, CompletedRunResult, ToolCallResult, UsageSummary } from "../../contracts/run.js";
import type { CheckpointPolicy, SessionStore } from "../../contracts/session.js";
import type { ToolRuntime } from "../../contracts/tool.js";
import { FrameworkError, safeError, runFailureStatus, ToolSuspended } from "../../contracts/errors.js";
import { canonical, jsonValue } from "../../shared/json.js";
type ToolCall = { callId: string; name: string; input: JsonValue };
type Continuation = {
  runId: string;
  continuationId: string;
  phase: "model" | "tools" | "completed";
  step: number;
  stepId: string;
  messageId: string;
  pending: ToolCall[];
  results: ToolCallResult[];
  usage: UsageSummary;
  text: string;
  continuationText: string;
  lengthContinuations: number;
  budgetReason?: BudgetReason;
  usageSamples?: number;
};
const unknownUsage = (): UsageSummary => ({
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
  reasoningTokens: null,
});
export class BasicLoop implements AgentExecutor {
  constructor(
    private readonly definition: SessionDefinition,
    private readonly store: SessionStore,
    private readonly context: ContextBuilder,
    private readonly model: ModelAdapter,
    private readonly tools: ToolRuntime,
    private readonly compactor: () => ContextCompactor | undefined,
    private readonly checkpoints: () => readonly CheckpointPolicy[],
    private readonly limits: { maxSteps?: number; maxToolCalls?: number; maxLengthContinuations: number },
  ) {}
  async compact(run: RunExecution) {
    const compactor = this.compactor();
    if (!compactor) return { status: "skipped" as const, reason: "CAPABILITY_UNAVAILABLE" };
    return {
      status: (
        await compactor.compact({
          signal: run.signal,
          route: run.model,
          force: true,
        })
      ).compacted
        ? ("compacted" as const)
        : ("skipped" as const),
    };
  }
  async execute(run: RunExecution): Promise<RunResult> {
    let results: ToolCallResult[] = [];
    let text = "";
    let usage = unknownUsage();
    let usageSamples = 0;
    const recordUsage = (next: UsageSummary) => {
      usage = {
        inputTokens: this.addUsage(usage.inputTokens, next.inputTokens, usageSamples),
        outputTokens: this.addUsage(usage.outputTokens, next.outputTokens, usageSamples),
        cachedInputTokens: this.addUsage(usage.cachedInputTokens, next.cachedInputTokens, usageSamples),
        reasoningTokens: this.addUsage(usage.reasoningTokens, next.reasoningTokens, usageSamples),
      };
      usageSamples++;
    };
    let pending: ToolCall[] = [];
    let continuationText = "";
    let lengthContinuations = 0;
    let status: CompletedRunResult["status"] = "succeeded";
    let error: CompletedRunResult["error"];
    let continuation: Continuation | undefined;
    try {
      run.signal.throwIfAborted();
      const initialSnapshot = await this.store.load();
      if (run.resume) {
        continuation = initialSnapshot.continuation as unknown as Continuation | undefined;
        if (
          !continuation ||
          continuation.runId !== run.runId ||
          continuation.continuationId !== run.resume.continuationId
        )
          throw new FrameworkError("INVALID_CONTINUATION", "No continuation exists for this run.");
        results = [...continuation.results];
        usage = continuation.usage;
        usageSamples = continuation.usageSamples ?? continuation.step;
        if (continuation.phase === "completed" && continuation.budgetReason) status = "budget_exhausted";
        text = continuation.text;
        continuationText = continuation.continuationText;
        lengthContinuations = continuation.lengthContinuations;
        if (continuation.phase === "tools") {
          pending = continuation.pending;
          const executed = await this.tools.execute(pending, { ...run, stepId: continuation.stepId });
          results.push(
            ...executed.filter((result) => !results.some((item) => item.executionId === result.executionId)),
          );
          continuation = {
            ...continuation,
            phase: "model",
            step: continuation.step + 1,
            messageId: "",
            pending: [],
            results,
          };
          await this.commitResults(executed, continuation);
          pending = [];
          if (executed.some((result) => result.outcome === "unknown"))
            throw new FrameworkError("TOOL_OUTCOME_UNKNOWN", "A dispatched operation requires inspection.");
        }
      } else {
        if (!run.message) throw new FrameworkError("INVALID_INPUT", "A new run requires a message.");
        continuation = {
          runId: run.runId,
          continuationId: randomUUID(),
          phase: "model",
          step: 0,
          stepId: "",
          messageId: "",
          pending: [],
          results,
          usage,
          text,
          continuationText,
          lengthContinuations,
        };
        await this.store.commit(
          { messages: [{ ...run.message, id: run.message.id ?? randomUUID() }], continuation: jsonValue(continuation) },
          initialSnapshot.revision,
        );
      }
      for (let step = continuation.step; continuation.phase !== "completed"; step++) {
        run.signal.throwIfAborted();
        for (const policy of this.checkpoints()) await policy.before("agent/pre-step", run.signal);
        let budgetReason: BudgetReason | undefined = continuation.budgetReason;
        if (!budgetReason && this.limits.maxSteps !== undefined && step >= this.limits.maxSteps)
          budgetReason = "STEP_LIMIT";
        if (!budgetReason && this.limits.maxToolCalls !== undefined && results.length >= this.limits.maxToolCalls)
          budgetReason = "TOOL_LIMIT";
        const stepId = randomUUID();
        const recoveringDraft = Boolean(
          run.resume && step === continuation.step && continuation.phase === "model" && continuation.messageId,
        );
        const messageId: string =
          (continuationText || recoveringDraft) && continuation.messageId ? continuation.messageId : randomUUID();
        continuation = {
          ...continuation,
          phase: "model",
          step,
          stepId,
          messageId,
          results,
          usage,
          text,
          continuationText,
          lengthContinuations,
          usageSamples,
          ...(budgetReason ? { budgetReason } : {}),
        };
        const beforeModel = await this.store.load();
        await this.store.commit({ continuation: jsonValue(continuation) }, beforeModel.revision);
        run.emit({ type: "message.started", sessionId: this.definition.sessionId, runId: run.runId, messageId });
        if (recoveringDraft)
          run.emit({
            type: "assistant.reset",
            sessionId: this.definition.sessionId,
            runId: run.runId,
            messageId,
            blockId: "text",
            attempt: 1,
          });
        const tools = this.tools.catalog();
        const contextInput = {
          signal: run.signal,
          route: run.model,
          toolSchemaCharacters: JSON.stringify(tools).length,
        };
        const compactor = this.compactor();
        const compact = async (force = false) => {
          if (!compactor) return;
          const result = await compactor.compact({ ...contextInput, runId: run.runId, force });
          if (result.usage) recordUsage(this.validateUsage(result.usage));
        };
        await compact();
        let messages;
        try {
          messages = await this.context.build(contextInput);
        } catch (failure) {
          if (!(failure instanceof FrameworkError) || failure.code !== "CONTEXT_LIMIT" || !compactor) throw failure;
          await compact(true);
          messages = await this.context.build(contextInput);
        }
        let completed: AgentMessage | undefined;
        let finish: Extract<ModelChunk, { type: "finished" }>["reason"] | undefined;
        let stepUsage = unknownUsage();
        const events = new Map<string, ToolCall>();
        let requestMessages: readonly AgentMessage[] = continuationText
          ? [
              ...messages,
              { role: "assistant", parts: [{ type: "text", text: continuationText }] },
              {
                role: "user",
                parts: [
                  {
                    type: "text",
                    text: "Continue the previous answer directly from where it stopped. Do not repeat text already written, and finish the complete answer.",
                  },
                ],
              },
            ]
          : messages;
        if (budgetReason)
          requestMessages = [
            ...requestMessages,
            {
              role: "system",
              parts: [
                {
                  type: "text",
                  text: `${budgetReason}: The configured work budget is exhausted. Tools are disabled. In the user's language, explain that the task is unfinished, summarize completed work and verified results, list remaining work and the next useful step. Do not claim completion. The user can continue in another run.`,
                },
              ],
            },
          ];
        for (const policy of this.checkpoints()) await policy.before("llm/stream", run.signal);
        run.signal.throwIfAborted();
        for await (const chunk of this.model.stream({
          sessionId: this.definition.sessionId,
          runId: run.runId,
          stepId,
          messages: requestMessages,
          tools,
          ...(budgetReason ? { toolChoice: "none" as const } : {}),
          signal: run.signal,
          ...(run.reasoningEffort ? { reasoningEffort: run.reasoningEffort } : {}),
          route: run.model,
        })) {
          run.signal.throwIfAborted();
          if (finish) throw new FrameworkError("MODEL_PROTOCOL", "Model emitted data after finish.");
          switch (chunk.type) {
            case "text.delta":
            case "thinking.delta":
              run.emit({
                type: "assistant.delta",
                sessionId: this.definition.sessionId,
                runId: run.runId,
                messageId,
                blockId: chunk.partId,
                contentType: chunk.type === "thinking.delta" ? "thinking" : "text",
                text: chunk.text,
              });
              break;
            case "reset":
              events.clear();
              completed = undefined;
              stepUsage = unknownUsage();
              run.emit({
                type: "assistant.reset",
                sessionId: this.definition.sessionId,
                runId: run.runId,
                messageId,
                blockId: "text",
                attempt: chunk.attempt,
              });
              break;
            case "tool.call": {
              if (events.has(chunk.callId))
                throw new FrameworkError("MODEL_PROTOCOL", "Duplicate complete tool call event.");
              events.set(chunk.callId, {
                callId: chunk.callId,
                name: chunk.name,
                input: jsonValue(chunk.input),
              });
              break;
            }
            case "message.completed":
              if (completed || chunk.message.role !== "assistant")
                throw new FrameworkError("MODEL_PROTOCOL", "Invalid completed assistant message.");
              completed = structuredClone(chunk.message);
              jsonValue(completed);
              break;
            case "usage":
              stepUsage = this.validateUsage(chunk.usage);
              break;
            case "finished":
              finish = chunk.reason;
              break;
            case "error":
              throw new FrameworkError(
                chunk.error.code,
                "Model request failed.",
                chunk.error.retryable,
                chunk.error.detail,
              );
          }
        }
        if (!completed)
          throw new FrameworkError(
            finish === "length" ? "MODEL_LENGTH" : "MODEL_PROTOCOL",
            finish === "length"
              ? "Model reached the configured output limit before completing a response. Increase the model output limit or ask for a shorter response."
              : "Model did not complete a valid step.",
          );
        const calls = completed.parts.filter((part) => part.type === "tool-call");
        if (new Set(calls.map((call) => call.callId)).size !== calls.length || events.size !== calls.length)
          throw new FrameworkError("MODEL_PROTOCOL", "Invalid tool call completion.");
        for (const event of events.values()) {
          const call = calls.find((item) => item.callId === event.callId);
          if (!call || call.name !== event.name || canonical(call.input) !== canonical(event.input))
            throw new FrameworkError("MODEL_PROTOCOL", "Tool event and assistant message disagree.");
        }
        recordUsage(stepUsage);
        if (budgetReason && calls.length)
          throw new FrameworkError("MODEL_PROTOCOL", "Model requested tools during the budget summary.");
        const stepText = completed.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        if (finish === "length") {
          continuationText += stepText;
          continuation = { ...continuation, continuationText, lengthContinuations: lengthContinuations + 1 };
          const lengthSnapshot = await this.store.load();
          await this.store.commit({ continuation: jsonValue(continuation) }, lengthSnapshot.revision);
          lengthContinuations++;
          if (calls.length || !stepText || lengthContinuations > this.limits.maxLengthContinuations || budgetReason)
            throw new FrameworkError(
              "MODEL_LENGTH",
              "Model reached the configured output limit. Increase the model output limit or ask for a shorter response.",
            );
          continue;
        }
        if ((finish !== "stop" && finish !== "tool-calls") || (finish === "tool-calls") !== calls.length > 0)
          throw new FrameworkError("MODEL_PROTOCOL", "Model did not complete a valid step.");
        const committed: AgentMessage = continuationText
          ? {
              ...completed,
              parts: prependText(completed.parts, continuationText),
            }
          : completed;
        // Public identity is allocated before streaming and survives final commit.
        const snapshot = await this.store.load();
        if (!calls.length)
          text = committed.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
        continuation = {
          ...continuation,
          phase: calls.length ? "tools" : "completed",
          pending: calls,
          results,
          usage,
          usageSamples,
          text,
          continuationText: "",
          lengthContinuations,
        };
        await this.store.commit(
          { messages: [{ ...committed, id: messageId }], continuation: jsonValue(continuation) },
          snapshot.revision,
        );
        continuationText = "";
        pending = calls;
        run.emit({
          type: "message.committed",
          sessionId: this.definition.sessionId,
          runId: run.runId,
          messageId,
        });
        if (!calls.length) {
          if (budgetReason) status = "budget_exhausted";
          text = committed.parts
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          break;
        }
        pending = calls;
        if (this.limits.maxToolCalls !== undefined && results.length + calls.length > this.limits.maxToolCalls) {
          const rejected: ToolCallResult[] = calls.map((call) => ({
            name: call.name,
            callId: call.callId,
            executionId: randomUUID(),
            status: "failed",
            value: { error: { code: "TOOL_LIMIT", message: "Not dispatched: the tool budget cannot fit this batch." } },
          }));
          results.push(...rejected);
          continuation = {
            ...continuation,
            phase: "model",
            step: step + 1,
            messageId: "",
            pending: [],
            results,
            budgetReason: "TOOL_LIMIT",
          };
          await this.commitResults(rejected, continuation);
          pending = [];
          continue;
        }
        const executed = await this.tools.execute(calls, { ...run, stepId });
        results.push(...executed);
        continuation = { ...continuation, phase: "model", step: step + 1, messageId: "", pending: [], results };
        await this.commitResults(executed, continuation);
        pending = [];
        if (executed.some((result) => result.outcome === "unknown"))
          throw new FrameworkError(
            "TOOL_OUTCOME_UNKNOWN",
            "A tool may still have applied its effect. The loop stopped without retrying or issuing further tool calls.",
          );
        run.signal.throwIfAborted();
      }
    } catch (failure) {
      if (failure instanceof ToolSuspended && continuation) {
        const suspended = { ...continuation, continuationId: failure.continuationId, pending, results, usage, text };
        const snapshot = await this.store.load();
        await this.store.commit({ continuation: jsonValue(suspended) }, snapshot.revision);
        return {
          kind: "suspended",
          sessionId: this.definition.sessionId,
          runId: run.runId,
          status: "waiting_input",
          continuationId: failure.continuationId,
          text,
          toolCalls: results,
          usage,
        };
      }
      if (failure instanceof FrameworkError && failure.code === "PERSISTENCE_FAILED") throw failure;
      if (continuationText) {
        const partial: AgentMessage = { role: "assistant", parts: [{ type: "text", text: continuationText }] };
        const partialId = randomUUID();
        const partialSnapshot = await this.store.load();
        await this.store.commit({ messages: [{ ...partial, id: partialId }] }, partialSnapshot.revision);
        text = continuationText;
        run.emit({
          type: "message.committed",
          sessionId: this.definition.sessionId,
          runId: run.runId,
          messageId: partialId,
        });
      }
      status = runFailureStatus(run.signal);
      error = safeError(run.signal.aborted ? run.signal.reason : failure);
      if (pending.length) {
        const interrupted: ToolCallResult[] = pending.map((call) => ({
          name: call.name,
          callId: call.callId,
          executionId: randomUUID(),
          status: "failed",
          value: {
            error: {
              code: error?.code ?? "EXECUTION_FAILED",
              message: "Tool step interrupted.",
            },
          },
        }));
        results.push(...interrupted);
        await this.commitResults(interrupted);
      }
    }
    const result: CompletedRunResult = {
      kind: "completed",
      sessionId: this.definition.sessionId,
      runId: run.runId,
      status,
      text,
      toolCalls: results,
      usage,
      ...(status === "budget_exhausted" && continuation?.budgetReason
        ? { budgetReason: continuation.budgetReason }
        : {}),
      ...(error ? { error } : {}),
    };
    const snapshot = await this.store.load();
    await this.store.commit({ run: result, continuation: null }, snapshot.revision);
    return result;
  }
  private addUsage(total: number | null, next: number | null, step: number): number | null {
    if (step === 0) return next;
    return total === null || next === null ? null : total + next;
  }
  private validateUsage(value: UsageSummary): UsageSummary {
    const fields = [value.inputTokens, value.outputTokens, value.cachedInputTokens, value.reasoningTokens];
    if (fields.some((field) => field !== null && (!Number.isSafeInteger(field) || field < 0)))
      throw new FrameworkError("MODEL_USAGE", "Model usage is invalid.");
    return { ...value };
  }
  private async commitResults(results: readonly ToolCallResult[], continuation?: Continuation): Promise<void> {
    const snapshot = await this.store.load();
    await this.store.commit(
      {
        ...(continuation ? { continuation: jsonValue(continuation) } : {}),
        messages: results.map((result) => ({
          id: result.executionId,
          role: "tool",
          parts: [
            {
              type: "tool-result",
              callId: result.callId,
              name: result.name,
              status: result.status,
              value: result.value ?? null,
            },
          ],
        })),
      },
      snapshot.revision,
    );
  }
}

function prependText(parts: AgentMessage["parts"], text: string): AgentMessage["parts"] {
  const firstText = parts.findIndex((part) => part.type === "text");
  if (firstText < 0) return [{ type: "text", text }, ...parts];
  return parts.map((part, index) =>
    index === firstText && part.type === "text" ? { ...part, text: `${text}${part.text}` } : part,
  );
}
