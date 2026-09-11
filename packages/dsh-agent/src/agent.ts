import { randomUUID } from "node:crypto";
import { Ajv } from "ajv";
import { Context } from "@deepseek-ai/cordis";
import AgentRegistry, { installModelSelection, type AgentHandle, type ModelSelectionRef } from "@deepseek-ai/dsh-agent";
import AgentLoop from "@deepseek-ai/dsh-agent-loop";
import LlmRuntime, { createSystemMessage, createUserMessage, LlmError } from "@deepseek-ai/dsh-llm";
import * as PiAi from "@deepseek-ai/dsh-llm-pi-ai";
import SessionStore, { SessionId } from "@deepseek-ai/dsh-session";
import SessionProjection from "@deepseek-ai/dsh-session-projection";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import Tools, { type ToolDefinition as DshTool } from "@deepseek-ai/dsh-tools";
import TokenMeter from "@deepseek-ai/dsh-token-meter";
import BasicCompaction from "@deepseek-ai/dsh-compaction-basic";
import { SessionCredentials } from "./credentials.js";
import { DshAgentError } from "./contracts.js";
import type {
  AgentEventPayload,
  AgentRunResult,
  AgentSession,
  CompactResult,
  ModelConfig,
  OperationOptions,
  SendOptions,
  SessionOptions,
  ToolCallResult,
} from "./contracts.js";

import { fail, positive, protocol } from "./validation.js";
export async function createAgent(
  options: SessionOptions,
  initial: ModelConfig,
  resolve: (id: string) => ModelConfig,
  acquire: () => () => void,
  onDisposed: () => void,
): Promise<AgentSession> {
  const ctx = new Context();
  // No raw vendor diagnostics are exported or buffered by this boundary.
  ctx.logger.bufferSize = 0;
  let handle: AgentHandle;
  let credentials: SessionCredentials;
  const selection: ModelSelectionRef = { current: undefined, assembled: undefined };
  try {
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(SessionStore);
    await ctx.plugin(SessionProjection);
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false });
    await ctx.plugin(Tools, { mode: "native", maxParallelSubCalls: 1 });
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(AgentLoop, { agents: [] });
    await ctx.plugin(TokenMeter);
    credentials = new SessionCredentials(ctx);
    handle = await ctx.agents.create({
      sessionId: SessionId(options.sessionId),
      agentOptions: { provider: "business", model: initial.model, maxTokens: initial.maxOutputTokens! },
      setup(agentCtx) {
        installModelSelection(agentCtx, selection);
        agentCtx.systemPrompt.section({ name: "business", order: 0, text: options.systemPrompt, complete: true });
        const names = new Set<string>();
        const validator = new Ajv({ strict: true, allErrors: true });
        for (const tool of options.tools ?? []) {
          if (typeof tool.parameters !== "object" || tool.parameters.type !== "object") {
            fail("INVALID_TOOL", "Tool parameters must declare an object schema");
          }
          if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name))
            fail("INVALID_TOOL", "Invalid or duplicate tool name");
          names.add(tool.name);
          const validate = validator.compile(tool.parameters);
          agentCtx.tools.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters as DshTool["parameters"],
            output: { schema: {}, render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
            async execute(args, execution) {
              if (!validate(args)) throw new Error("Tool arguments do not match the declared schema");
              try {
                return await tool.execute(args, { signal: execution.signal, sessionId: options.sessionId });
              } catch {
                throw new Error("Business tool execution failed");
              }
            },
          });
        }
        agentCtx.tools.guard((execution) =>
          names.has(execution.name) ? undefined : "Tool is not allowed in this session",
        );
      },
    });
  } catch (error) {
    await ctx.fiber.dispose();
    if (error instanceof DshAgentError) throw error;
    return fail("SESSION_SETUP_FAILED", "Could not assemble session runtime");
  }
  const agent = handle.agent;
  let lastModel = initial.id;
  let previousModelName = initial.model;
  let closed = false;
  let running: Promise<unknown> | undefined;
  let controller: AbortController | undefined;
  let disposal: Promise<void> | undefined;
  function cancel() {
    controller?.abort();
    agent.cancel({ kind: "user" });
  }

  function operate(mode: "send", input: SendOptions): Promise<AgentRunResult>;
  function operate(mode: "compact", input: OperationOptions): Promise<CompactResult>;
  function operate(
    mode: "send" | "compact",
    input: SendOptions | OperationOptions,
  ): Promise<AgentRunResult | CompactResult> {
    if (closed) return Promise.reject(new DshAgentError("CLOSED", "Session is closed"));
    if (running) return Promise.reject(new DshAgentError("BUSY", "Session already has an active operation"));
    let model: ModelConfig;
    let release: () => void;
    const timeout = input.timeoutMs ?? 120_000;
    try {
      positive(timeout, "timeoutMs");
      if (mode === "send" && (!("text" in input) || !input.text.trim()))
        fail("INVALID_INPUT", "Non-empty text is required");
      model = resolve(mode === "send" ? ((input as SendOptions).model ?? options.model ?? initial.id) : lastModel);
      release = acquire();
    } catch (error) {
      return Promise.reject(error);
    }
    controller = new AbortController();
    const abort = controller;
    let timedOut = false;
    let observerFailed = false;
    const turnId = randomUUID();
    const toolCalls: ToolCallResult[] = [];
    const result: AgentRunResult = { sessionId: options.sessionId, turnId, status: "succeeded", text: "", toolCalls };
    const emit = (event: AgentEventPayload) => {
      if (observerFailed) return;
      try {
        input.onEvent?.({ ...event, sessionId: options.sessionId, turnId });
      } catch {
        observerFailed = true;
        cancel();
      }
    };
    const externalAbort = () => cancel();
    input.signal?.addEventListener("abort", externalAbort, { once: true });
    if (input.signal?.aborted) abort.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      cancel();
    }, timeout);
    const startOffset = agent.session.snapshotEvents().length;
    const header = {
      config: { provider: "business", model: model.model, maxTokens: model.maxOutputTokens! },
      tools: (options.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters as DshTool["parameters"],
      })),
    };
    const measure = () =>
      ctx.tokenMeter.measure(agent.session, header).totalTokens +
      (agent.session.snapshotEvents().some((event) => event.type === "system/message")
        ? 0
        : ctx.tokenMeter.estimateMessage(createSystemMessage(options.systemPrompt, "business")));
    const stopConfig = agent.ctx.on("agent/request", async (_payload, next) => ({
      ...(await next()),
      maxTokens: model.maxOutputTokens!,
    }));
    const stopBudget = agent.ctx.on(
      "agent/pre-step",
      async (_payload, next) => {
        const decision = await next();
        if (
          decision.kind === "enter" &&
          measure() + decision.messages.reduce((sum, message) => sum + ctx.tokenMeter.estimateMessage(message), 0) >=
            model.contextWindow - model.maxOutputTokens!
        ) {
          throw new LlmError("Context cannot fit in the selected model", "CONTEXT_LIMIT");
        }
        return decision;
      },
      { prepend: true },
    );
    const stopStream = agent.ctx.on("agent/assistant-stream", ({ frame }) => {
      if (frame.type === "chunk" && frame.chunk.type === "text-delta")
        emit({ type: "assistant.delta", text: frame.chunk.text });
    });
    const stopTool = agent.ctx.on("tools/result", (execution, outcome) => {
      const call: ToolCallResult = {
        callId: execution.callId,
        toolName: execution.name,
        status: outcome.isError ? "failed" : "succeeded",
        ...(outcome.isError ? {} : { value: outcome.value }),
      };
      toolCalls.push(call);
      emit({ type: "tool.finished", ...call });
      return undefined;
    });
    const stopEvents = ctx.on("session/event", (_session, event) => {
      if (event.type === "tool/call")
        emit({ type: "tool.started", callId: event.data.callId, toolName: event.data.name });
      if (event.type === "compaction/start") emit({ type: "compression.started" });
      if (event.type === "compaction/end")
        emit({ type: "compression.finished", status: event.data.error ? "failed" : "succeeded" });
    });
    // Deferring one microtask publishes the busy owner before callbacks can reenter.
    running = Promise.resolve()
      .then(async () => {
        const mounted: Array<{ dispose(): Promise<unknown> }> = [];
        let compacted = false;
        try {
          if (mode === "send") emit({ type: "turn.started" });
          if (abort.signal.aborted) throw new Error("Cancelled");
          credentials.key = model.apiKey;
          const modelNames = [...new Set([model.model, previousModelName])];
          const adapter = ctx.plugin(PiAi, {
            providers: {
              business: {
                api: protocol[model.protocol],
                baseURL: model.baseURL,
                apiKeyEnv: "SESSION_KEY",
                models: modelNames.map((id) => ({
                  id,
                  contextWindow: model.contextWindow,
                  maxTokens: model.maxOutputTokens!,
                })),
                retryPolicy: { mode: "normal", maxRetries: 0 },
              },
            },
          });
          mounted.push(adapter);
          await adapter;
          selection.current = { provider: "business", model: model.model };
          agent.options.model = model.model;
          agent.options.maxTokens = model.maxOutputTokens!;
          const inputBudget = model.contextWindow - model.maxOutputTokens!;
          const threshold = options.compression!.thresholdRatio! * inputBudget;
          const compaction = ctx.plugin(BasicCompaction, {
            auto: options.compression!.enabled!,
            thresholdRatio: threshold / model.contextWindow,
            retainRatio: Math.min(0.16, threshold / model.contextWindow / 2),
            summarizationProvider: "business",
            summarizationModel: model.model,
            maxTokens: model.maxOutputTokens!,
            compactionRetries: 0,
          });
          mounted.push(compaction);
          await compaction;
          if (abort.signal.aborted) throw new Error("Cancelled");
          if (mode === "compact") {
            compacted = (await ctx.compaction.compactNow(agent, abort.signal)) !== null;
          } else {
            const message = createUserMessage({
              content: [{ type: "text", text: (input as SendOptions).text }],
              source: { kind: "user" },
            });
            const extra = ctx.tokenMeter.estimateMessage(message);
            if (options.compression!.enabled && measure() + extra >= threshold) {
              await ctx.compaction.compactNow(agent, abort.signal);
            }
            if (measure() + extra >= inputBudget) fail("CONTEXT_LIMIT", "Input exceeds model context capacity");
            if (abort.signal.aborted) throw new Error("Cancelled");
            lastModel = model.id;
            previousModelName = model.model;
            agent.followup(message);
            await agent.whenIdle();
            const events = agent.session.snapshotEvents().slice(startOffset);
            for (const event of events) {
              if (event.type === "assistant/message") {
                result.text = event.data.message.content
                  .filter((block) => block.type === "text")
                  .map((block) => block.text)
                  .join("");
              }
              if ((event.type === "assistant/message" || event.type === "compaction/summary") && event.data.usage) {
                result.usage ??= { inputTokens: 0, outputTokens: 0 };
                result.usage.inputTokens += event.data.usage.inputTokens;
                result.usage.outputTokens += event.data.usage.outputTokens;
              }
            }
            const end = events.findLast((event) => event.type === "turn/end");
            if (end?.type !== "turn/end" || end.data.reason.kind !== "completed") {
              result.status = "failed";
              result.error = {
                code:
                  end?.type === "turn/end" && end.data.reason.kind === "max-tokens"
                    ? "OUTPUT_LIMIT"
                    : end?.type === "turn/end" &&
                        end.data.reason.kind === "error" &&
                        end.data.reason.error.code === "CONTEXT_LIMIT"
                      ? "CONTEXT_LIMIT"
                      : "MODEL_FAILED",
                message: "Model turn did not complete",
              };
            }
          }
        } catch (error) {
          result.status = "failed";
          result.error = {
            code: error instanceof DshAgentError ? error.code : "OPERATION_FAILED",
            message: error instanceof DshAgentError ? error.message : "Agent operation failed",
          };
        } finally {
          for (const mount of mounted.reverse()) {
            try {
              await mount.dispose();
            } catch {
              result.status = "failed";
              result.error = { code: "CLEANUP_FAILED", message: "Operation cleanup failed" };
            }
          }
          credentials.key = undefined;
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", externalAbort);
          stopStream();
          stopTool();
          stopEvents();
          stopConfig();
          stopBudget();
        }
        if (abort.signal.aborted) {
          result.status = timedOut ? "timed_out" : "cancelled";
          result.error = {
            code: timedOut ? "TIMEOUT" : "CANCELLED",
            message: timedOut ? "Operation timed out" : "Operation cancelled",
          };
        }
        if (observerFailed) {
          result.status = "failed";
          result.error = { code: "EVENT_CALLBACK_FAILED", message: "Event callback failed" };
        }
        if (mode === "send") {
          emit({ type: "turn.finished", status: result.status });
          if (observerFailed) {
            result.status = "failed";
            result.error = { code: "EVENT_CALLBACK_FAILED", message: "Event callback failed" };
          }
          return result;
        }
        return {
          status: result.status === "succeeded" ? (compacted ? "compacted" : "skipped") : result.status,
          ...(result.error ? { error: result.error } : {}),
        } satisfies CompactResult;
      })
      .finally(() => {
        release();
        running = undefined;
        controller = undefined;
      });
    return running as Promise<AgentRunResult | CompactResult>;
  }
  return {
    sessionId: options.sessionId,
    send: (input) => operate("send", input),
    compact: (input = {}) => operate("compact", input),
    cancel,
    dispose() {
      if (disposal) return disposal;
      closed = true;
      cancel();
      disposal = (async () => {
        try {
          await running;
          await handle.dispose();
        } finally {
          await ctx.fiber.dispose();
          credentials.key = undefined;
          onDisposed();
        }
      })();
      return disposal;
    },
  };
}
