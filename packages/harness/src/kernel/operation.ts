import { randomUUID } from "node:crypto";
import type {
  AgentExecutor,
  AgentSession,
  CompactResult,
  OperationOptions,
  RunExecution,
  SendOptions,
  SessionDefinition,
} from "../contracts/agent.js";
import type { AdmissionLease, ResourceClaim } from "../contracts/admission.js";
import type { AgentMessage, JsonValue } from "../contracts/message.js";
import type { RunResult } from "../contracts/run.js";
import type { PluginRegistration } from "../contracts/runtime.js";
import {
  agentExecutor,
  contextCompactor,
  diagnostics,
  eventJournal,
  eventObservers,
  modelRouter,
  sessionStore,
} from "../contracts/capabilities.js";
import { FrameworkError, safeError } from "../contracts/errors.js";
import { jsonValue, positive } from "../shared/json.js";
import { ResourceAdmission } from "./admission.js";
import { Context } from "./context.js";
export class SessionHandle implements AgentSession {
  private active?: {
    context: Context;
    promise: Promise<RunResult | CompactResult>;
  };
  private waiting?: { runId: string; continuationId: string };
  private closing?: Promise<void>;
  readonly namespace: string;
  readonly sessionId: string;
  constructor(
    private readonly definition: SessionDefinition,
    private readonly context: Context,
    private readonly resources: ResourceAdmission,
    private readonly plugins: readonly PluginRegistration[],
    private readonly maxRuns: number,
    private readonly timeout: number,
    private readonly isKernelClosed: () => boolean,
    private readonly onClose: () => void,
    private readonly cancelTasks: () => Promise<void>,
  ) {
    this.namespace = definition.namespace;
    this.sessionId = definition.sessionId;
  }
  async inspect() {
    const snapshot = await this.context.optional(sessionStore)?.load();
    return {
      namespace: this.namespace,
      sessionId: this.sessionId,
      ...(this.definition.model ? { model: this.definition.model } : {}),
      allowedTools: [...this.definition.allowedTools],
      revision: snapshot?.revision ?? 0,
      active: this.active !== undefined,
      waiting: this.waiting !== undefined,
    };
  }
  claims(): readonly ResourceClaim[] {
    this.assertOpen();
    return [
      { key: "agent.active", units: 1, limit: this.maxRuns },
      {
        key: "session:" + JSON.stringify([this.namespace, this.sessionId]),
        units: 1,
        limit: 1,
      },
    ];
  }
  send(options: SendOptions): Promise<RunResult> {
    return this.sendWithLease(options);
  }
  async sendWithLease(options: SendOptions, lease?: AdmissionLease): Promise<RunResult> {
    this.assertOpen();
    const snapshot = await this.context.optional(sessionStore)?.load();
    const continuation = snapshot?.continuation as { runId?: string; continuationId?: string } | undefined;
    if (!this.waiting && continuation?.runId && continuation.continuationId)
      this.waiting = { runId: continuation.runId, continuationId: continuation.continuationId };
    if (this.active || this.waiting) throw new FrameworkError("BUSY", "Session already has an operation.");
    if ((options.text === undefined) === (options.message === undefined))
      throw new FrameworkError("INVALID_INPUT", "Provide exactly one of text or message.");
    if (options.text !== undefined && (typeof options.text !== "string" || !options.text.trim()))
      throw new FrameworkError("INVALID_INPUT", "Message text must not be empty.");
    if (
      options.runId !== undefined &&
      (typeof options.runId !== "string" || !options.runId || options.runId.length > 128)
    )
      throw new FrameworkError("INVALID_INPUT", "Run ID is invalid.");
    const message: AgentMessage =
      options.message === undefined
        ? { role: "user", parts: [{ type: "text", text: options.text }] }
        : structuredClone(options.message);
    jsonValue(message);
    if (
      message.role !== "user" ||
      !message.parts.length ||
      message.parts.some((part) => part.type === "tool-call" || part.type === "tool-result")
    )
      throw new FrameworkError("INVALID_INPUT", "Only user content is accepted.");
    return this.start(
      "send",
      options,
      {
        message,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
      },
      lease,
    );
  }
  async compact(options: OperationOptions = {}): Promise<CompactResult> {
    this.assertOpen();
    if (this.active || this.waiting) throw new FrameworkError("BUSY", "Session already has an operation.");
    if (!this.context.optional(contextCompactor)) return { status: "skipped", reason: "CAPABILITY_UNAVAILABLE" };
    return this.start("compact", options, {});
  }
  async resume(
    options: OperationOptions & {
      runId: string;
      continuationId: string;
      input: JsonValue;
    },
  ): Promise<RunResult> {
    this.assertOpen();
    const snapshot = await this.context.optional(sessionStore)?.load();
    const continuation = snapshot?.continuation as { runId?: string; continuationId?: string } | undefined;
    if (!this.waiting && continuation?.runId && continuation.continuationId)
      this.waiting = { runId: continuation.runId, continuationId: continuation.continuationId };
    if (this.active || this.waiting?.runId !== options.runId || this.waiting.continuationId !== options.continuationId)
      throw new FrameworkError("INVALID_CONTINUATION", "The continuation is not active.");
    const resume = {
      continuationId: options.continuationId,
      input: jsonValue(options.input),
    };
    return this.start("resume", options, { runId: options.runId, resume });
  }
  async resumeWithLease(
    options: OperationOptions & {
      runId: string;
      continuationId: string;
      input: JsonValue;
    },
    lease: AdmissionLease,
  ): Promise<RunResult> {
    this.assertOpen();
    if (this.active || this.waiting?.runId !== options.runId || this.waiting.continuationId !== options.continuationId)
      throw new FrameworkError("INVALID_CONTINUATION", "The continuation is not active.");
    return this.start(
      "resume",
      options,
      {
        runId: options.runId,
        resume: {
          continuationId: options.continuationId,
          input: jsonValue(options.input),
        },
      },
      lease,
    );
  }
  cancel(): void {
    if (this.active) this.active.context.abort(new FrameworkError("CANCELLED", "Operation cancelled."));
    else if (this.waiting) this.waiting = undefined;
  }
  dispose(): Promise<void> {
    this.closing ??= Promise.resolve().then(async () => {
      this.cancel();
      const errors: unknown[] = [];
      try {
        await this.cancelTasks();
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.active?.promise;
      } catch (error) {
        errors.push(error);
      }
      try {
        await this.context.dispose();
      } catch (error) {
        errors.push(error);
      }
      this.onClose();
      if (errors.length) throw new FrameworkError("CLEANUP_FAILED", "Session cleanup failed.");
    });
    return this.closing;
  }
  private assertOpen(): void {
    if (this.closing || this.isKernelClosed() || this.context.signal.aborted)
      throw new FrameworkError("CLOSED", "Session is closed.");
  }
  private start(kind: "compact", options: OperationOptions, input: Partial<RunExecution>): Promise<CompactResult>;
  private start(
    kind: "send" | "resume",
    options: OperationOptions,
    input: Partial<RunExecution>,
    lease?: AdmissionLease,
  ): Promise<RunResult>;
  private start(
    kind: "send" | "resume" | "compact",
    options: OperationOptions,
    input: Partial<RunExecution>,
    suppliedLease?: AdmissionLease,
  ): Promise<RunResult | CompactResult> {
    options.signal?.throwIfAborted();
    const timeout = positive(options.timeoutMs ?? this.timeout, "timeoutMs");
    const modelProvider = this.context.optional(modelRouter);
    const model = modelProvider?.snapshot?.(this.definition.model);
    const claims: readonly ResourceClaim[] = [
      { key: "agent.active", units: 1, limit: this.maxRuns },
      {
        key: "session:" + JSON.stringify([this.namespace, this.sessionId]),
        units: 1,
        limit: 1,
      },
    ];
    const lease = suppliedLease ?? this.resources.tryAcquire(claims);
    if (!lease) throw new FrameworkError("CAPACITY", "Active Agent capacity is exhausted.");
    if (!this.resources.owns(lease, claims))
      throw new FrameworkError("INVALID_ADMISSION", "Invalid Agent admission lease.");
    let runContext: Context;
    try {
      runContext = this.context.fork("run");
    } catch (error) {
      if (!suppliedLease) lease.release();
      throw error;
    }
    const runId = input.runId ?? randomUUID();
    let sequence = 0;
    const report = this.context.resolve(diagnostics);
    const signal = options.signal ? AbortSignal.any([runContext.signal, options.signal]) : runContext.signal;
    const timer = setTimeout(
      () => runContext.abort(new FrameworkError("TIMED_OUT", "Operation deadline exceeded.")),
      timeout,
    );
    const run: RunExecution = {
      ...input,
      runId,
      signal,
      deadlineAt: Date.now() + timeout,
      model,
      emit: (event) => {
        const enriched = {
          ...event,
          schemaVersion: 1 as const,
          namespace: this.namespace,
          eventId: randomUUID(),
          seq: ++sequence,
          timestamp: Date.now(),
        };
        try {
          this.context.optional(eventJournal)?.publish(enriched);
          for (const observer of this.context.collect(eventObservers)) {
            try {
              const result = observer.observe(structuredClone(enriched));
              if (result instanceof Promise)
                void result.catch(() =>
                  report({
                    code: "OBSERVER_FAILED",
                    message: "An event observer failed.",
                  }),
                );
            } catch {
              report({
                code: "OBSERVER_FAILED",
                message: "An event observer failed.",
              });
            }
          }
          options.onEvent?.(structuredClone(enriched));
        } catch {
          report({
            code: "OBSERVER_FAILED",
            message: "An event observer failed.",
          });
        }
      },
    };
    const promise = Promise.resolve()
      .then(async (): Promise<RunResult | CompactResult> => {
        try {
          await runContext.install(this.plugins);
          const executor: AgentExecutor = runContext.resolve(agentExecutor);
          if (kind !== "compact") run.emit({ type: "run.started", sessionId: this.sessionId, runId });
          const result = kind === "compact" ? await executor.compact(run) : await executor.execute(run);
          if ("kind" in result) {
            this.waiting = result.kind === "suspended" ? { runId, continuationId: result.continuationId } : undefined;
            if (result.kind === "completed")
              run.emit({
                type: "run.finished",
                sessionId: this.sessionId,
                runId,
                status: result.status,
              });
          }
          return result;
        } catch (error) {
          if (kind === "compact") return { status: "failed", reason: safeError(error).code };
          const status = signal.aborted
            ? signal.reason instanceof FrameworkError && signal.reason.code === "TIMED_OUT"
              ? "timed_out"
              : "cancelled"
            : "failed";
          const result: RunResult = {
            kind: "completed",
            sessionId: this.sessionId,
            runId,
            status,
            text: "",
            toolCalls: [],
            usage: {
              inputTokens: null,
              outputTokens: null,
              cachedInputTokens: null,
              reasoningTokens: null,
            },
            error: safeError(error),
          };
          run.emit({
            type: "run.finished",
            sessionId: this.sessionId,
            runId,
            status,
          });
          return result;
        }
      })
      .finally(async () => {
        clearTimeout(timer);
        try {
          await runContext.dispose();
        } finally {
          this.active = undefined;
          if (!suppliedLease) lease.release();
        }
      });
    this.active = { context: runContext, promise };
    return promise;
  }
}
