import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Admission, ResourceClaim } from "../../contracts/admission.js";
import type { SessionDefinition } from "../../contracts/agent.js";
import type { CheckpointPolicy, SessionStore, ExecutionRecord } from "../../contracts/session.js";
import { commitSessionUpdate } from "../../contracts/session.js";
import type { ToolContext, ToolDefinition, ToolPolicy, ToolRuntime } from "../../contracts/tool.js";
import type { ToolCallResult } from "../../contracts/run.js";
import type { JsonValue } from "../../contracts/message.js";
import { FrameworkError, safeError, ToolFailureError, ToolSuspended } from "../../contracts/errors.js";
import { canonical, jsonValue } from "../../shared/json.js";
export class ToolExecutor implements ToolRuntime {
  constructor(
    private readonly session: SessionDefinition,
    private readonly store: SessionStore,
    private readonly admission: Admission,
    private readonly tools: ReadonlyMap<string, ToolDefinition>,
    private readonly policies: () => readonly ToolPolicy[],
    private readonly checkpoints: () => readonly CheckpointPolicy[],
    private readonly limits: {
      reads: number;
      writes: number;
      maxOutputBytes: number;
    },
  ) {}
  private readonly inFlight = new Map<string, Promise<ToolCallResult>>();
  catalog(): ReturnType<ToolRuntime["catalog"]> {
    return [...this.tools.values()]
      .filter((tool) => this.session.allowedTools.includes(tool.name))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: structuredClone(tool.inputSchemaJson ?? jsonValue(z.toJSONSchema(tool.inputSchema))),
      }));
  }
  async execute(
    calls: Parameters<ToolRuntime["execute"]>[0],
    run: Parameters<ToolRuntime["execute"]>[1],
  ): Promise<readonly ToolCallResult[]> {
    const seen = new Map<string, { name: string; input: JsonValue }>();
    for (const call of calls) {
      if (!call || typeof call.callId !== "string" || !call.callId || typeof call.name !== "string")
        throw new FrameworkError("INVALID_TOOL_INPUT", "Invalid tool call.");
      const input = jsonValue(call.input);
      const previous = seen.get(call.callId);
      if (previous && (previous.name !== call.name || canonical(previous.input) !== canonical(input)))
        throw new FrameworkError("MODEL_PROTOCOL", "A tool call ID was reused with different arguments.");
      seen.set(call.callId, { name: call.name, input });
    }
    const settled = await Promise.allSettled(calls.map((call) => this.executeCall(call, run)));
    const results: ToolCallResult[] = [];
    for (const result of settled) {
      if (result.status === "rejected") throw result.reason;
      results.push(result.value);
    }
    return results;
  }
  private executeCall(
    call: Parameters<ToolRuntime["execute"]>[0][number],
    run: Parameters<ToolRuntime["execute"]>[1],
  ): Promise<ToolCallResult> {
    const key = JSON.stringify([run.runId, run.stepId, call.callId]);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const execution = this.executeCallOnce(call, run).finally(() => {
      if (this.inFlight.get(key) === execution) this.inFlight.delete(key);
    });
    this.inFlight.set(key, execution);
    return execution;
  }
  private async executeCallOnce(
    call: Parameters<ToolRuntime["execute"]>[0][number],
    run: Parameters<ToolRuntime["execute"]>[1],
  ): Promise<ToolCallResult> {
    const snapshot = await this.store.load();
    const previous = snapshot.executions.find(
      (item) => item.runId === run.runId && item.stepId === run.stepId && item.callId === call.callId,
    );
    if (previous && (previous.name !== call.name || canonical(previous.input) !== canonical(jsonValue(call.input))))
      throw new FrameworkError("IDEMPOTENCY_CONFLICT", "Tool call ID was reused with different arguments.");
    if (previous?.result) return previous.result;
    if (previous?.dispatch === "dispatched" && this.tools.get(call.name)?.effects !== "read") {
      const result: ToolCallResult = {
        name: call.name,
        callId: call.callId,
        executionId: previous.executionId,
        status: "failed",
        outcome: "unknown",
        error: { code: "TOOL_OUTCOME_UNKNOWN", message: "Previously dispatched operation requires inspection." },
      };
      await commitSessionUpdate(this.store, { execution: { ...previous, result } });
      return result;
    }
    const executionId = previous?.executionId ?? randomUUID();
    const tool = this.tools.get(call.name);
    const record: ExecutionRecord = previous ?? {
      executionId,
      runId: run.runId,
      stepId: run.stepId,
      callId: call.callId,
      name: call.name,
      input: call.input,
      dispatch: "intent",
      effects: tool?.effects ?? "write",
      idempotencyKey: JSON.stringify([this.session.namespace, run.runId, executionId]),
    };
    const offsets = { stdout: 0, stderr: 0 };
    let started = false;
    let invoked = false;
    let inputPrepared = false;
    let result: ToolCallResult | undefined;
    let heldLease: import("../../contracts/admission.js").AdmissionLease | undefined;
    const controller = new AbortController();
    const signal = AbortSignal.any([run.signal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      signal.throwIfAborted();
      if (!tool) throw new FrameworkError("UNKNOWN_TOOL", "Tool is not registered.");
      const prepared = tool.prepare(call.input);
      inputPrepared = true;
      if (!this.session.allowedTools.includes(call.name))
        throw new FrameworkError("TOOL_DENIED", "Tool is not allowed.");
      if (!previous) await commitSessionUpdate(this.store, { execution: record });
      const context: ToolContext = {
        signal,
        namespace: this.session.namespace,
        identity: structuredClone(this.session.identity),
        sessionId: this.session.sessionId,
        runId: run.runId,
        executionId,
        callId: call.callId,
        output: async (channel, text) => {
          const offset = offsets[channel];
          run.emit({
            type: "tool.output",
            sessionId: this.session.sessionId,
            runId: run.runId,
            executionId,
            callId: call.callId,
            channel,
            offset,
            text,
          });
          offsets[channel] += text.length;
        },
        idempotencyKey: record.idempotencyKey,
      };
      for (const policy of this.policies()) {
        const authorization = await policy.authorize({ name: call.name, input: prepared.input, context });
        if (typeof authorization === "object") throw new ToolSuspended(authorization.continuationId);
        if (authorization !== "allow") throw new FrameworkError("TOOL_DENIED", "Tool policy denied execution.");
      }
      const mode = tool.effects === "read" ? "read" : "write";
      const claims: ResourceClaim[] = [
        {
          key: "tools:" + mode,
          units: 1,
          limit: mode === "read" ? this.limits.reads : this.limits.writes,
        },
      ];
      const resource = tool.resourceKey?.(prepared.input);
      if (resource) claims.push({ key: "tool.resource:" + resource, units: 1, limit: 1 });
      if (tool.timeoutMs)
        timer = setTimeout(
          () => controller.abort(new FrameworkError("TIMED_OUT", "Tool deadline exceeded.")),
          tool.timeoutMs,
        );
      heldLease = await this.admission.acquire(claims, signal);
      {
        for (const policy of this.checkpoints()) await policy.before("tools/execute", signal);
        if (signal.aborted) throw new FrameworkError("ABORTED_BEFORE_DISPATCH", "Tool aborted before dispatch.");
        await commitSessionUpdate(this.store, { execution: { ...record, dispatch: "dispatched" } });
        if (signal.aborted) throw new FrameworkError("ABORTED_BEFORE_DISPATCH", "Tool aborted before dispatch.");
        started = true;
        run.emit({
          type: "tool.started",
          sessionId: this.session.sessionId,
          runId: run.runId,
          executionId,
          callId: call.callId,
          name: call.name,
        });
        const attempts = tool.retry?.maxAttempts ?? 1;
        if (
          !Number.isSafeInteger(attempts) ||
          attempts < 1 ||
          attempts > 10 ||
          (attempts > 1 && tool.effects !== "read" && !tool.retry?.idempotent)
        )
          throw new FrameworkError("INVALID_CONFIG", "Unsafe tool retry configuration.");
        let value;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          signal.throwIfAborted();
          try {
            invoked = true;
            value = await prepared.execute(context);
            break;
          } catch (error) {
            if (attempt === attempts || signal.aborted || !(error instanceof FrameworkError) || !error.retryable)
              throw error;
          }
        }
        result = {
          name: call.name,
          callId: call.callId,
          executionId,
          status: "succeeded",
          value: jsonValue(value, this.limits.maxOutputBytes),
        };
      }
    } catch (error) {
      if (
        error instanceof ToolSuspended ||
        (!invoked && error instanceof FrameworkError && error.code === "PERSISTENCE_FAILED")
      )
        throw error;
      let outcome: ToolCallResult["outcome"] = "known";
      if (error instanceof ToolFailureError) outcome = error.outcome;
      else if (
        invoked &&
        tool?.effects !== "read" &&
        !(error instanceof FrameworkError && error.code === "NOT_DISPATCHED")
      )
        outcome = "unknown";
      let failureCode = "TOOL_FAILED";
      if (signal.aborted) failureCode = "CANCELLED";
      else if (error instanceof z.ZodError) failureCode = inputPrepared ? "INVALID_TOOL_OUTPUT" : "INVALID_TOOL_INPUT";
      result = {
        name: call.name,
        callId: call.callId,
        executionId,
        status: "failed",
        outcome,
        error: safeError(error, failureCode),
      };
      result.value = {
        error: {
          code: result.error?.code ?? "TOOL_FAILED",
          message: result.error?.message ?? "Tool failed.",
        },
        outcome: result.outcome ?? "known",
        ...(error instanceof ToolFailureError && error.details !== undefined ? { details: error.details } : {}),
      };
    } finally {
      try {
        if (result) await commitSessionUpdate(this.store, { execution: { ...record, result } });
      } finally {
        if (timer) clearTimeout(timer);
        heldLease?.release();
      }
    }
    if (!result) throw new FrameworkError("TOOL_FAILED", "Tool execution did not produce a result.");
    if (started)
      run.emit({
        type: "tool.finished",
        sessionId: this.session.sessionId,
        runId: run.runId,
        executionId,
        name: call.name,
        status: result.status,
      });
    return result;
  }
}
