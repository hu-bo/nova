// taskflow.md §1：编排层，且只是编排层。零依赖纯调度器——
// 只认识"会返回 Promise 的函数"和"它们之间的先后关系"，不认识 Agent / Tool / Runner / Execution。

export type TaskId = string;

export interface RetryPolicy {
  /** 最大重试次数，不含首次 */
  max: number;
  /** 缺省 500。指数退避 + 全抖动：delay ∈ [0, backoffMs * 2^(attempt-1)) */
  backoffMs?: number;
  /** 缺省：全部可重试 */
  retryable?: (error: unknown) => boolean;
}

export interface TaskSpec {
  /** 省略则自动生成 */
  id?: TaskId;
  deps?: TaskId[];
  run: (ctx: TaskContext) => Promise<unknown>;
  timeoutMs?: number;
  retry?: RetryPolicy;
}

export interface TaskContext {
  taskId: TaskId;
  /** 从 1 开始 */
  attempt: number;
  signal: AbortSignal;
  /** 动态追加，规则同 flow.addTask（§5） */
  addTask(spec: TaskSpec): TaskId;
  /** 已完成依赖的返回值 */
  results: ReadonlyMap<TaskId, unknown>;
}

export interface FlowOptions {
  /** 缺省 8 */
  concurrency?: number;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryPolicy;
}

export type TerminalStatus = "succeeded" | "failed" | "timedOut" | "cancelled" | "skipped";

export type TaskEvent =
  | { type: "task.ready"; taskId: TaskId }
  | { type: "task.started"; taskId: TaskId; attempt: number }
  | { type: "task.succeeded"; taskId: TaskId; result: unknown; durationMs: number }
  // attempt = 刚刚失败的那次尝试（error 属于它）
  | { type: "task.retrying"; taskId: TaskId; attempt: number; delayMs: number; error: unknown }
  | { type: "task.finished"; taskId: TaskId; status: TerminalStatus; error?: unknown }
  | { type: "flow.finished"; counts: Record<TerminalStatus, number> };

export interface Flow {
  addTask(task: TaskSpec): TaskId;
  run(): AsyncIterable<TaskEvent>;
  /** 省略 taskId = 取消整个 flow */
  cancel(taskId?: TaskId): void;
}

type TaskStatus = "pending" | "ready" | "running" | TerminalStatus;

interface TaskNode {
  id: TaskId;
  deps: TaskId[];
  dependents: TaskNode[];
  run: (ctx: TaskContext) => Promise<unknown>;
  timeoutMs: number | undefined;
  retry: RetryPolicy | undefined;
  state: TaskStatus;
  attempt: number;
  result: unknown;
  cancelRequested: boolean;
  controller: AbortController | undefined;
  timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  // 重试退避等待中：state 仍为 ready，但不在 readyQueue 里，等 timer 到期重新入队
  retryTimer: ReturnType<typeof setTimeout> | undefined;
}

export function createFlow(options: FlowOptions = {}): Flow {
  const concurrency = options.concurrency ?? 8;
  if (concurrency < 1) throw new Error(`concurrency must be >= 1, got ${concurrency}`);

  const nodes = new Map<TaskId, TaskNode>();
  const readyQueue: TaskNode[] = []; // FIFO，无优先级（§6）
  const buffer: TaskEvent[] = [];
  let runningCount = 0;
  let counter = 0;
  let started = false; // run() 的迭代开始后才派发
  let done = false; // flow.finished 已发出
  let iterableCreated = false;
  let notify: (() => void) | undefined;

  function emit(event: TaskEvent): void {
    buffer.push(event);
    const signal = notify;
    notify = undefined;
    signal?.();
  }

  function addTask(spec: TaskSpec): TaskId {
    if (done) throw new Error("cannot add tasks after the flow has finished");
    const id = spec.id ?? nextId();
    if (nodes.has(id)) throw new Error(`duplicate task id: ${id}`);
    const deps = [...(spec.deps ?? [])];
    for (const dep of deps) {
      if (dep === id) throw new Error(`task ${id} would create a dependency cycle`);
      if (!nodes.has(dep)) throw new Error(`task ${id} depends on unknown task: ${dep}`);
    }
    if (createsCycle(id, deps)) throw new Error(`task ${id} would create a dependency cycle`);

    const node: TaskNode = {
      id,
      deps,
      dependents: [],
      run: spec.run,
      timeoutMs: spec.timeoutMs ?? options.defaultTimeoutMs,
      retry: spec.retry ?? options.defaultRetry,
      state: "pending",
      attempt: 1,
      result: undefined,
      cancelRequested: false,
      controller: undefined,
      timeoutTimer: undefined,
      retryTimer: undefined,
    };
    nodes.set(id, node);
    for (const dep of deps) nodes.get(dep)!.dependents.push(node);

    // §5：依赖已全部 succeeded → 立即 ready；含非 succeeded 终态依赖 → 立即 skipped
    if (deps.every((dep) => nodes.get(dep)!.state === "succeeded")) {
      enqueueReady(node);
    } else if (deps.some((dep) => isTerminal(nodes.get(dep)!.state) && nodes.get(dep)!.state !== "succeeded")) {
      finishAs(node, "skipped");
    }
    pump();
    return id;
  }

  function nextId(): TaskId {
    do {
      counter += 1;
    } while (nodes.has(`t${counter}`));
    return `t${counter}`;
  }

  // 依赖只在 addTask 时声明且 id 唯一，环只能经由新任务自己的 deps 闭合——
  // 从 deps 出发遍历能回到 id 即成环（增量检测，§5）
  function createsCycle(id: TaskId, deps: TaskId[]): boolean {
    const seen = new Set<TaskId>();
    const stack = [...deps];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === id) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...nodes.get(current)!.deps);
    }
    return false;
  }

  function enqueueReady(node: TaskNode): void {
    node.state = "ready";
    readyQueue.push(node);
    emit({ type: "task.ready", taskId: node.id });
  }

  function pump(): void {
    if (!started || done) return;
    while (runningCount < concurrency && readyQueue.length > 0) {
      start(readyQueue.shift()!);
    }
    // §4：没有 running 且没有 ready（skipped 传播后也不会剩 pending）时结束
    for (const node of nodes.values()) {
      if (node.state === "pending" || node.state === "ready" || node.state === "running") return;
    }
    done = true;
    const counts: Record<TerminalStatus, number> = { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, skipped: 0 };
    for (const node of nodes.values()) counts[node.state as TerminalStatus] += 1;
    emit({ type: "flow.finished", counts });
  }

  function start(node: TaskNode): void {
    node.state = "running";
    runningCount += 1;
    const attempt = node.attempt;
    const controller = new AbortController();
    node.controller = controller;
    const startedAt = Date.now();
    let timedOut = false;
    if (node.timeoutMs !== undefined) {
      node.timeoutTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, node.timeoutMs);
    }
    const results = new Map<TaskId, unknown>();
    for (const dep of node.deps) results.set(dep, nodes.get(dep)!.result);
    emit({ type: "task.started", taskId: node.id, attempt });
    Promise.resolve()
      .then(() => node.run({ taskId: node.id, attempt, signal: controller.signal, addTask, results }))
      .then(
        (value) => settle(node, startedAt, timedOut, { ok: true, value }),
        (error) => settle(node, startedAt, timedOut, { ok: false, error }),
      );
  }

  function settle(
    node: TaskNode,
    startedAt: number,
    timedOut: boolean,
    outcome: { ok: true; value: unknown } | { ok: false; error: unknown },
  ): void {
    if (node.timeoutTimer !== undefined) clearTimeout(node.timeoutTimer);
    node.timeoutTimer = undefined;
    runningCount -= 1;
    // 优先级：取消 > 超时 > 正常结果。cancel 后即使 run 正常返回也算 cancelled（§6）
    if (node.cancelRequested) {
      finishAs(node, "cancelled");
    } else if (timedOut) {
      retryOrFinish(node, startedAt, "timedOut", new Error(`task ${node.id} timed out after ${node.timeoutMs}ms`));
    } else if (outcome.ok) {
      node.result = outcome.value;
      finishAs(node, "succeeded", startedAt);
    } else {
      retryOrFinish(node, startedAt, "failed", outcome.error);
    }
  }

  function retryOrFinish(node: TaskNode, startedAt: number, kind: "failed" | "timedOut", error: unknown): void {
    const policy = node.retry;
    if (policy && node.attempt - 1 < policy.max && (policy.retryable?.(error) ?? true)) {
      const delayMs = Math.floor(Math.random() * (policy.backoffMs ?? 500) * 2 ** (node.attempt - 1));
      const failedAttempt = node.attempt;
      node.attempt += 1;
      node.state = "ready";
      emit({ type: "task.retrying", taskId: node.id, attempt: failedAttempt, delayMs, error });
      node.retryTimer = setTimeout(() => {
        node.retryTimer = undefined;
        enqueueReady(node);
        pump();
      }, delayMs);
    } else {
      finishAs(node, kind, startedAt, error);
    }
    pump();
  }

  function finishAs(node: TaskNode, status: TerminalStatus, startedAt?: number, error?: unknown): void {
    node.state = status;
    if (status === "succeeded") {
      emit({
        type: "task.succeeded",
        taskId: node.id,
        result: node.result,
        durationMs: Date.now() - (startedAt ?? Date.now()),
      });
    }
    emit(
      error === undefined
        ? { type: "task.finished", taskId: node.id, status }
        : { type: "task.finished", taskId: node.id, status, error },
    );
    propagate(node, status);
    pump();
  }

  // §4：succeeded 解锁下游 ready；其它终态沿依赖边传播 skipped
  function propagate(node: TaskNode, status: TerminalStatus): void {
    for (const dependent of node.dependents) {
      if (dependent.state !== "pending") continue;
      if (status === "succeeded") {
        if (dependent.deps.every((dep) => nodes.get(dep)!.state === "succeeded")) enqueueReady(dependent);
      } else {
        finishAs(dependent, "skipped");
      }
    }
  }

  function cancelOne(node: TaskNode): void {
    switch (node.state) {
      case "running":
        // §6：abort signal → 等 run 收敛 → cancelled（settle 里判定）
        node.cancelRequested = true;
        node.controller?.abort();
        break;
      case "ready":
        if (node.retryTimer !== undefined) clearTimeout(node.retryTimer);
        node.retryTimer = undefined;
        {
          const index = readyQueue.indexOf(node);
          if (index !== -1) readyQueue.splice(index, 1);
        }
        finishAs(node, "cancelled");
        break;
      case "pending":
        finishAs(node, "cancelled");
        break;
      // 终态：幂等 no-op
    }
  }

  function cancel(taskId?: TaskId): void {
    if (taskId === undefined) {
      for (const node of [...nodes.values()]) cancelOne(node);
      return;
    }
    const node = nodes.get(taskId);
    if (!node) throw new Error(`unknown task id: ${taskId}`);
    cancelOne(node);
  }

  function run(): AsyncIterable<TaskEvent> {
    if (iterableCreated) throw new Error("run() can only be called once");
    iterableCreated = true;
    return {
      [Symbol.asyncIterator]() {
        started = true;
        pump();
        return iterate();
      },
    };
  }

  async function* iterate(): AsyncGenerator<TaskEvent> {
    while (true) {
      while (buffer.length > 0) yield buffer.shift()!;
      if (done) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }

  return { addTask, run, cancel };
}

function isTerminal(state: TaskStatus): state is TerminalStatus {
  return state !== "pending" && state !== "ready" && state !== "running";
}
