import { randomUUID } from "node:crypto";
import type { Admission, AdmissionLease, ResourceClaim } from "../../contracts/admission.js";
import type { TaskEngine, TaskStore, FlowSpec, FlowHandle } from "../../contracts/flow.js";
import type {
  TaskHandler,
  TaskSpec,
  TaskSnapshot,
  TaskHandle,
  TaskResult,
  TaskContext,
  TaskEvent,
} from "../../contracts/task.js";
import type { TaskQueue } from "../../contracts/queue.js";
import type { TaskSignal } from "../../contracts/continuation.js";
import type { JsonValue } from "../../contracts/message.js";
import type { FlowPredicate } from "../../contracts/flow.js";
import { FrameworkError, safeError } from "../../contracts/errors.js";
import { canonical, jsonValue } from "../../shared/json.js";
import { isDeepStrictEqual } from "node:util";
import { EventStream } from "../../shared/events.js";
import { terminal, transition } from "./task-state.js";
import { WaitRegistry } from "./waits.js";
import { FlowCoordinator } from "./flow.js";
export interface EngineOptions {
  maxConcurrentTasks: number;
  maxConcurrentPerKey: number;
  maxNodesPerFlow: number;
  maxDepth: number;
  retryBaseMs: number;
  retryMaxMs: number;
  retryJitter: boolean;
  resources: Readonly<Record<string, number>>;
  predicates?: Readonly<Record<string, FlowPredicate>>;
}
interface LiveTask {
  handle: TaskHandle;
  complete(result: TaskResult): void;
  events: EventStream<TaskEvent>;
  sequence: number;
  controller?: AbortController;
  execution?: Promise<void>;
  cancelStatus?: "cancelled" | "timed_out";
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || value instanceof Array) return false;
  const prototype = Reflect.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
export class TaskRuntime implements TaskEngine {
  private readonly live = new Map<string, LiveTask>();
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly deduplication = new Map<string, { hash: string; taskId: string }>();
  private sequence = 0;
  private scheduled = false;
  private closing = false;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly unsubscribe: () => void;
  private readonly waits: WaitRegistry;
  private readonly flows: FlowCoordinator;
  constructor(
    private readonly store: TaskStore,
    private readonly queue: TaskQueue,
    private readonly admission: Admission,
    readonly options: EngineOptions,
    private readonly report: (error: { code: string; message: string }) => void,
  ) {
    this.unsubscribe = admission.subscribe(() => this.kick());
    this.waits = new WaitRegistry(queue.maxPending, (id) => this.wake(id));
    this.flows = new FlowCoordinator(
      {
        validate: (spec, bindings) => this.validate(spec, bindings),
        ensureCapacity: (count) => this.ensureCapacity(count),
        accept: (spec, flowId) => this.accept(spec, "blocked", flowId),
        get: (id) => this.store.get(id),
        ready: (id, input) => this.ready(id, input),
        cancel: (id) => this.cancel(id),
        skip: (id) => this.finish(id, { taskId: id, status: "skipped" }),
        fail: (id, error) =>
          this.finish(id, {
            taskId: id,
            status: "failed",
            error: safeError(error),
          }),
        retain: (id) => this.store.retain(id),
        discard: (id) => this.discard(id),
      },
      options.maxNodesPerFlow,
      new Map(Object.entries(options.predicates ?? {})),
    );
  }
  register(handlers: readonly TaskHandler[]): void {
    for (const handler of handlers) {
      const key = handler.kind + ":" + handler.version;
      if (!handler.kind || !Number.isSafeInteger(handler.version) || handler.version < 1 || this.handlers.has(key))
        throw new FrameworkError("DUPLICATE_HANDLER", "Invalid or duplicate handler: " + key);
      this.handlers.set(key, handler);
    }
  }
  validate(spec: TaskSpec, bindings = false): TaskSpec {
    if (this.closing) throw new FrameworkError("CLOSED", "Task engine is closing.");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(spec.kind)) throw new FrameworkError("INVALID_INPUT", "Invalid task kind.");
    if (!Number.isSafeInteger(spec.version) || spec.version < 1)
      throw new FrameworkError("INVALID_INPUT", "Invalid task version.");
    const handler = this.handler(spec);
    if (!Number.isSafeInteger(spec.deadlineAt) || spec.deadlineAt <= Date.now())
      throw new FrameworkError("INVALID_INPUT", "Task deadline must be in the future.");
    const attempts = spec.maxAttempts ?? 1;
    if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 100 || (attempts > 1 && !handler.retrySafe))
      throw new FrameworkError("UNSAFE_RETRY", "Handler does not permit this retry policy.");
    if (spec.priority !== undefined && (!Number.isSafeInteger(spec.priority) || Math.abs(spec.priority) > 1_000))
      throw new FrameworkError("INVALID_INPUT", "Priority must be within -1000..1000.");
    if (spec.notBefore !== undefined && (!Number.isSafeInteger(spec.notBefore) || spec.notBefore < 0))
      throw new FrameworkError("INVALID_INPUT", "Invalid delay.");
    if (
      spec.idempotencyKey !== undefined &&
      (typeof spec.idempotencyKey !== "string" || !spec.idempotencyKey.length || spec.idempotencyKey.length > 512)
    )
      throw new FrameworkError("INVALID_INPUT", "Invalid idempotency key.");
    if (
      spec.concurrencyKey !== undefined &&
      (typeof spec.concurrencyKey !== "string" || !spec.concurrencyKey.length || spec.concurrencyKey.length > 512)
    )
      throw new FrameworkError("INVALID_INPUT", "Invalid concurrency key.");
    if (spec.resources !== undefined && !isPlainRecord(spec.resources))
      throw new FrameworkError("INVALID_RESOURCE", "Task resources must be an object.");
    const input = jsonValue(spec.input);
    if (!bindings && handler.inputSchema) {
      const parsed = this.parseTaskInput(handler.inputSchema, input);
      if (!isDeepStrictEqual(parsed, input))
        throw new FrameworkError("INVALID_INPUT", "Task input must not be coerced, defaulted or stripped.");
    }
    const normalized = {
      ...structuredClone(spec),
      namespace: spec.namespace ?? "local",
      input,
    };
    if (typeof normalized.namespace !== "string" || !normalized.namespace.length)
      throw new FrameworkError("INVALID_INPUT", "Namespace must not be empty.");
    this.resourceClaims(normalized);
    return normalized;
  }
  ensureCapacity(count: number): void {
    this.prune();
    if (this.store.list().filter((task) => !terminal(task.status)).length + count > this.queue.maxPending)
      throw new FrameworkError("QUEUE_FULL", "Task acceptance capacity reached.");
    if (this.store.list().length + count > this.store.maxTasks)
      throw new FrameworkError("TASK_STORE_FULL", "Task retention capacity reached.");
  }
  submit(input: TaskSpec): TaskHandle {
    const spec = this.validate(input);
    const key = spec.idempotencyKey ? JSON.stringify([spec.namespace, spec.idempotencyKey]) : undefined;
    this.prune();
    if (key) {
      const existing = this.deduplication.get(key);
      if (existing) {
        if (existing.hash !== canonical(jsonValue(spec)))
          throw new FrameworkError("IDEMPOTENCY_CONFLICT", "Idempotency key was used with a different request.");
        const task = this.live.get(existing.taskId);
        if (task) return task.handle;
      }
    }
    this.ensureCapacity(1);
    const handle = this.accept(spec);
    if (key)
      this.deduplication.set(key, {
        hash: canonical(jsonValue(spec)),
        taskId: handle.taskId,
      });
    return handle;
  }
  submitFlow(spec: FlowSpec): FlowHandle {
    return this.flows.submit(spec);
  }
  private accept(
    spec: TaskSpec,
    status: "queued" | "blocked" = "queued",
    flowId?: string,
    parentTaskId?: string,
  ): TaskHandle {
    const taskId = randomUUID();
    let complete!: (result: TaskResult) => void;
    const result = new Promise<TaskResult>((resolve) => {
      complete = resolve;
    });
    const events = new EventStream<TaskEvent>();
    const snapshot: TaskSnapshot = {
      taskId,
      namespace: spec.namespace ?? "local",
      status,
      spec,
      sequence: ++this.sequence,
      attempts: 0,
      acceptedAt: Date.now(),
      ...(flowId ? { flowId } : {}),
      ...(parentTaskId ? { parentTaskId } : {}),
    };
    this.store.set(snapshot);
    const handle: TaskHandle = {
      taskId,
      result: () => result.then((value) => structuredClone(value)),
      snapshot: () => {
        const current = this.store.get(taskId);
        if (!current) throw new FrameworkError("TASK_EXPIRED", "Task snapshot expired.");
        return current;
      },
      events: () => events.read(),
      cancel: () => this.cancel(taskId),
    };
    this.live.set(taskId, { handle, complete, events, sequence: 0 });
    try {
      if (status === "queued") this.enqueue(snapshot);
      this.changed(snapshot);
    } catch (error) {
      this.live.delete(taskId);
      events.close();
      this.store.delete(taskId);
      throw error;
    }
    return handle;
  }
  signal(input: TaskSignal) {
    if (!input || typeof input !== "object" || typeof input.taskId !== "string" || typeof input.waitId !== "string")
      throw new FrameworkError("INVALID_SIGNAL", "Signal identity is invalid.");
    const task = this.store.get(input.taskId);
    if (!task || terminal(task.status) || task.status === "cancelling") return { status: "ignored" as const };
    return this.waits.signal(input);
  }
  cancel(taskId: string): void {
    this.cancelAs(taskId, "cancelled");
  }
  private cancelAs(taskId: string, status: "cancelled" | "timed_out"): void {
    const task = this.store.get(taskId);
    if (!task || terminal(task.status)) return;
    for (const child of this.store.list()) if (child.parentTaskId === taskId) this.cancelAs(child.taskId, status);
    const live = this.live.get(taskId);
    if (task.status === "running" || task.status === "cancelling") {
      if (!live) throw new FrameworkError("TASK_STATE", "Running task has no execution owner.");
      live.cancelStatus ??= status;
      if (task.status !== "cancelling") this.set(transition(task, "cancelling"));
      live.controller?.abort(
        new FrameworkError(status === "timed_out" ? "TIMED_OUT" : "CANCELLED", "Task execution cancelled."),
      );
    } else {
      if (task.status === "waiting") {
        try {
          this.handler(task.spec).cancel?.(task.spec.input, task.namespace);
        } catch (error) {
          this.report(safeError(error, "TASK_CANCEL_FAILED"));
        }
      }
      this.finish(taskId, { taskId, status });
    }
  }
  async cancelSession(namespace: string, sessionId: string): Promise<void> {
    const handles: TaskHandle[] = [];
    for (const task of this.store.list()) {
      const input = task.spec.input;
      if (
        task.spec.kind === "agent.send" &&
        input &&
        typeof input === "object" &&
        !Array.isArray(input) &&
        input.sessionId === sessionId &&
        (input.namespace ?? task.namespace) === namespace &&
        !terminal(task.status)
      ) {
        this.cancel(task.taskId);
        const handle = this.live.get(task.taskId)?.handle;
        if (handle) handles.push(handle);
      }
    }
    await Promise.all(handles.map((handle) => handle.result()));
  }
  async drain(options: { timeoutMs: number }): Promise<void> {
    if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
      throw new FrameworkError("INVALID_INPUT", "Drain timeout must be positive.");
    const pending = this.store
      .list()
      .filter((task) => !terminal(task.status))
      .flatMap((task) => {
        const live = this.live.get(task.taskId);
        return live ? [live.handle.result()] : [];
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all(pending),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FrameworkError("DRAIN_TIMEOUT", "Task drain deadline exceeded.")),
            options.timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async dispose(): Promise<void> {
    this.closing = true;
    if (this.timer) clearTimeout(this.timer);
    this.unsubscribe();
    for (const task of this.store.list()) this.cancel(task.taskId);
    await Promise.all([...this.live.values()].flatMap((task) => (task.execution ? [task.execution] : [])));
    this.queue.clear();
    for (const task of this.live.values()) task.events.close();
    this.live.clear();
    this.deduplication.clear();
  }
  private handler(spec: TaskSpec): TaskHandler {
    const handler = this.handlers.get(spec.kind + ":" + spec.version);
    if (!handler) throw new FrameworkError("UNKNOWN_HANDLER", "Unknown handler: " + spec.kind);
    return handler;
  }
  private resourceClaims(spec: TaskSpec): ResourceClaim[] {
    const claims: ResourceClaim[] = [{ key: "task.active", units: 1, limit: this.options.maxConcurrentTasks }];
    if (spec.concurrencyKey)
      claims.push({
        key: "task.key:" + spec.concurrencyKey,
        units: 1,
        limit: this.options.maxConcurrentPerKey,
      });
    for (const [key, units] of Object.entries(spec.resources ?? {})) {
      if (!key || !/^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(key))
        throw new FrameworkError("INVALID_RESOURCE", "Invalid task resource name.");
      const limit = this.options.resources[key];
      if (!limit || !Number.isSafeInteger(units) || units <= 0 || units > limit)
        throw new FrameworkError("INVALID_RESOURCE", "Invalid task resource: " + key);
      claims.push({ key: "task.resource:" + key, units, limit });
    }
    return claims;
  }
  private kick(): void {
    if (this.closing || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      try {
        this.dispatch();
      } catch (error) {
        this.report(safeError(error, "SCHEDULER_FAILED"));
      }
    });
  }
  private dispatch(): void {
    if (this.closing) return;
    if (this.timer) clearTimeout(this.timer);
    const now = Date.now();
    this.prune();
    for (const task of this.store.list())
      if (
        !terminal(task.status) &&
        (task.spec.deadlineAt <= now || (this.waits.expiry(task.taskId) ?? Infinity) <= now)
      )
        this.cancelAs(task.taskId, "timed_out");
    for (const item of this.queue.candidates(now)) {
      let task = this.store.get(item.taskId);
      if (!task || terminal(task.status)) {
        this.queue.remove(item.taskId);
        continue;
      }
      if (task.status === "retry_wait") {
        task = transition(task, "queued");
        this.set(task);
      }
      if (task.status !== "queued" || !this.flows.canRun(task.flowId, this.store.list())) continue;
      if (this.hasEarlierSessionTask(task)) continue;
      const handler = this.handler(task.spec);
      let claims: readonly ResourceClaim[];
      try {
        claims = [...this.resourceClaims(task.spec), ...(handler.claims?.(task.spec.input) ?? [])];
      } catch (error) {
        if (error instanceof FrameworkError && error.code === "BUSY") continue;
        this.finish(task.taskId, {
          taskId: task.taskId,
          status: "failed",
          error: safeError(error),
        });
        continue;
      }
      const lease = this.admission.tryAcquire(claims);
      if (!lease) continue;
      this.queue.remove(task.taskId);
      const live = this.live.get(task.taskId);
      if (!live) {
        lease.release();
        throw new FrameworkError("TASK_STATE", "Missing Task handle.");
      }
      const controller = new AbortController();
      live.controller = controller;
      this.set(transition(task, "running", { attempts: task.attempts + 1 }));
      live.execution = this.execute(task.taskId, handler, lease, claims, controller)
        .catch((error) => {
          this.report(safeError(error, "TASK_FINALIZATION_FAILED"));
        })
        .finally(() => {
          live.execution = undefined;
          live.controller = undefined;
          lease.release();
          this.kick();
        });
    }
    const deadlines = this.store
      .list()
      .filter((task) => !terminal(task.status) && task.status !== "cancelling")
      .map((task) => Math.min(task.spec.deadlineAt, this.waits.expiry(task.taskId) ?? Infinity));
    const next = Math.min(
      ...deadlines,
      this.queue.nextReadyAt(now) ?? Infinity,
      this.store.list().length ? now + 60_000 : Infinity,
    );
    if (Number.isFinite(next)) {
      this.timer = setTimeout(() => this.kick(), Math.max(1, next - now));
      if (!deadlines.length) this.timer.unref();
    }
  }
  private async execute(
    taskId: string,
    handler: TaskHandler,
    lease: AdmissionLease,
    claims: readonly ResourceClaim[],
    controller: AbortController,
  ): Promise<void> {
    const task = this.store.get(taskId);
    if (!task) throw new FrameworkError("TASK_STATE", "Task disappeared while executing.");
    let activeLease = lease;
    const children = new Set<TaskHandle>();
    let pendingChildWait: Promise<TaskResult> | undefined;
    const context: TaskContext = {
      taskId,
      namespace: task.namespace,
      signal: controller.signal,
      deadlineAt: task.spec.deadlineAt,
      attemptId: randomUUID(),
      get lease() {
        return activeLease;
      },
      createWait: (definition) =>
        this.waits.create(taskId, task.namespace, {
          ...definition,
          expiresAt: Math.min(definition.expiresAt, task.spec.deadlineAt),
        }),
      submitChild: (spec) => {
        let depth = 1;
        let ancestor: TaskSnapshot | undefined = task;
        while (ancestor?.parentTaskId) {
          depth++;
          ancestor = this.store.get(ancestor.parentTaskId);
        }
        if (depth >= this.options.maxDepth) throw new FrameworkError("TASK_DEPTH", "Task depth limit reached.");
        const child = this.validate({
          ...spec,
          namespace: task.namespace,
          deadlineAt: Math.min(spec.deadlineAt, task.spec.deadlineAt),
        });
        if (this.usesSameAgentSession(task, child))
          throw new FrameworkError("TASK_DEADLOCK", "A task cannot wait for an Agent task using the same session.");
        this.ensureCapacity(1);
        const handle = this.accept(child, "queued", task.flowId, taskId);
        children.add(handle);
        return handle;
      },
      waitFor: async (child) => {
        const childTask = child && typeof child.taskId === "string" ? this.store.get(child.taskId) : undefined;
        const childLive = childTask ? this.live.get(childTask.taskId) : undefined;
        if (!childTask || childTask.parentTaskId !== taskId || childLive?.handle !== child)
          throw new FrameworkError("INVALID_INPUT", "Task can only wait for a direct child.");
        if (pendingChildWait)
          throw new FrameworkError("TASK_STATE", "A task cannot wait for multiple children concurrently.");
        activeLease.release();
        const childWait = (async (): Promise<TaskResult> => {
          const result = await child.result();
          activeLease = await this.admission.acquire(claims, controller.signal);
          return result;
        })();
        pendingChildWait = childWait;
        return childWait.finally(() => {
          if (pendingChildWait === childWait) {
            pendingChildWait = undefined;
          }
        });
      },
    };
    try {
      controller.signal.throwIfAborted();
      const input = handler.inputSchema ? this.parseTaskInput(handler.inputSchema, task.spec.input) : task.spec.input;
      if (handler.inputSchema && !isDeepStrictEqual(input, task.spec.input))
        throw new FrameworkError("INVALID_INPUT", "Task input must not be coerced, defaulted or stripped.");
      if (handler.protocol === "outcome") {
        const continuation = this.waits.take(taskId);
        const outcome = continuation
          ? await handler.resume(continuation.state, continuation.signal, context)
          : await handler.execute(input, context);
        controller.signal.throwIfAborted();
        if (outcome.kind === "waiting") {
          const current = this.store.get(taskId);
          if (!current) throw new FrameworkError("TASK_STATE", "Missing waiting task.");
          const expiresAt = this.waits.expires(taskId, outcome.waitId);
          if (outcome.expiresAt !== expiresAt)
            throw new FrameworkError("INVALID_WAIT", "Waiting outcome expiry does not match its registration.");
          this.set(
            transition(current, "waiting", {
              wait: {
                waitId: outcome.waitId,
                expiresAt,
              },
            }),
          );
          this.waits.suspend(taskId, outcome.waitId, outcome.state);
          return;
        }
        this.finish(taskId, {
          taskId,
          status: "succeeded",
          output: handler.outputSchema
            ? this.strictSchemaOutput(handler.outputSchema, outcome.output)
            : jsonValue(outcome.output),
        });
      } else {
        const output = await handler.execute(input, context);
        controller.signal.throwIfAborted();
        this.finish(taskId, {
          taskId,
          status: "succeeded",
          output: handler.outputSchema ? this.strictSchemaOutput(handler.outputSchema, output) : jsonValue(output),
        });
      }
    } catch (error) {
      const live = this.live.get(taskId);
      const current = this.store.get(taskId);
      if (!current) throw error;
      if (live?.cancelStatus || controller.signal.aborted)
        this.finish(taskId, {
          taskId,
          status: live?.cancelStatus ?? "cancelled",
        });
      else if (
        handler.retrySafe &&
        error instanceof FrameworkError &&
        error.retryable &&
        current.attempts < (task.spec.maxAttempts ?? 1)
      ) {
        const cappedDelay = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** (current.attempts - 1));
        const delay = this.options.retryJitter
          ? Math.max(1, Math.floor(cappedDelay * (0.5 + Math.random() * 0.5)))
          : cappedDelay;
        const retry = transition(current, "retry_wait");
        this.waits.clear(taskId);
        this.set(retry);
        try {
          this.enqueue(retry, Date.now() + delay);
        } catch (enqueueError) {
          this.finish(taskId, {
            taskId,
            status: "failed",
            error: safeError(enqueueError, "QUEUE_FULL"),
          });
        }
      } else
        this.finish(taskId, {
          taskId,
          status: "failed",
          error: safeError(error),
        });
    } finally {
      for (const child of children) child.cancel();
      await Promise.all([...children].map((child) => child.result()));
      await pendingChildWait?.catch(() => undefined);
      activeLease.release();
    }
  }
  private strictSchemaOutput(schema: NonNullable<TaskHandler["outputSchema"]>, value: JsonValue): JsonValue {
    let parsed: JsonValue;
    try {
      parsed = jsonValue(schema.parse(value));
    } catch {
      throw new FrameworkError("INVALID_OUTPUT", "Task output does not match its schema.");
    }
    if (!isDeepStrictEqual(parsed, value))
      throw new FrameworkError("INVALID_OUTPUT", "Task output must not be coerced, defaulted or stripped.");
    return parsed;
  }
  private parseTaskInput(schema: NonNullable<TaskHandler["inputSchema"]>, value: JsonValue): JsonValue {
    try {
      return jsonValue(schema.parse(value));
    } catch {
      throw new FrameworkError("INVALID_INPUT", "Task input does not match its schema.");
    }
  }
  private hasEarlierSessionTask(task: TaskSnapshot): boolean {
    const input = task.spec.input;
    if (task.spec.kind !== "agent.send" || !input || typeof input !== "object" || Array.isArray(input)) return false;
    return this.store.list().some((other) => {
      const value = other.spec.input;
      return (
        other.sequence < task.sequence &&
        !terminal(other.status) &&
        other.spec.kind === "agent.send" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        value.sessionId === input.sessionId &&
        (value.namespace ?? other.namespace) === (input.namespace ?? task.namespace)
      );
    });
  }
  private usesSameAgentSession(parent: TaskSnapshot, child: TaskSpec): boolean {
    if (parent.spec.kind !== "agent.send" || child.kind !== "agent.send") return false;
    const parentInput = parent.spec.input;
    const childInput = child.input;
    if (
      !parentInput ||
      typeof parentInput !== "object" ||
      Array.isArray(parentInput) ||
      !childInput ||
      typeof childInput !== "object" ||
      Array.isArray(childInput)
    )
      return false;
    return (
      typeof parentInput.sessionId === "string" &&
      parentInput.sessionId === childInput.sessionId &&
      (parentInput.namespace ?? parent.namespace) === (childInput.namespace ?? child.namespace ?? parent.namespace)
    );
  }
  private enqueue(task: TaskSnapshot, readyAt = task.spec.notBefore ?? task.acceptedAt): void {
    this.queue.put({
      taskId: task.taskId,
      sequence: task.sequence,
      priority: task.spec.priority ?? 0,
      readyAt,
      acceptedAt: task.acceptedAt,
    });
    this.kick();
  }
  private ready(id: string, input: JsonValue): void {
    const task = this.store.get(id);
    if (!task || task.status !== "blocked") return;
    const normalized = this.validate({ ...task.spec, input }, false);
    const ready = transition(task, "queued", {
      spec: normalized,
    });
    this.set(ready);
    this.enqueue(ready);
  }
  private wake(id: string): void {
    const task = this.store.get(id);
    if (!task || task.status !== "waiting") return;
    const ready = transition(task, "queued", { wait: undefined });
    this.set(ready);
    this.enqueue(ready, Date.now());
  }
  private finish(id: string, result: TaskResult): void {
    const task = this.store.get(id);
    if (!task || terminal(task.status)) return;
    this.queue.remove(id);
    this.waits.clear(id);
    this.set(
      transition(task, result.status, {
        result,
        finishedAt: Date.now(),
        wait: undefined,
      }),
    );
    const live = this.live.get(id);
    live?.complete(result);
    live?.events.close();
  }
  private discard(id: string): void {
    const task = this.store.get(id);
    if (!task) return;
    const live = this.live.get(id);
    if (live?.execution) throw new FrameworkError("TASK_STATE", "An executing task cannot be discarded.");
    this.queue.remove(id);
    this.waits.clear(id);
    live?.complete({ taskId: id, status: "cancelled" });
    live?.events.close();
    this.live.delete(id);
    this.store.delete(id);
  }
  private set(task: TaskSnapshot): void {
    this.store.set(task);
    this.changed(task);
  }
  private changed(task: TaskSnapshot): void {
    const live = this.live.get(task.taskId);
    if (live)
      live.events.publish({
        schemaVersion: 1,
        eventId: randomUUID(),
        taskId: task.taskId,
        namespace: task.namespace,
        seq: ++live.sequence,
        timestamp: Date.now(),
        status: task.status,
      });
    this.flows.changed(task.flowId);
    this.kick();
  }
  private prune(): void {
    this.store.prune(Date.now());
    for (const [id, live] of this.live)
      if (!this.store.get(id) && !live.execution) {
        live.events.close();
        this.live.delete(id);
      }
    for (const [key, value] of this.deduplication) if (!this.store.get(value.taskId)) this.deduplication.delete(key);
  }
}
