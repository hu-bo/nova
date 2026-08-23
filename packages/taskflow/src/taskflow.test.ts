import { describe, expect, it } from "vitest";
import { createFlow, type Flow, type TaskEvent } from "./index.js";

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// 尊重 signal 的可中断等待：abort 时 reject，让 run 尽快收敛
function abortableSleep(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}

async function drain(flow: Flow): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  for await (const event of flow.run()) events.push(event);
  return events;
}

function shape(events: TaskEvent[]): string[] {
  return events.map(event => {
    if (event.type === "task.finished") return `finished:${event.taskId}:${event.status}`;
    if (event.type === "task.started") return `started:${event.taskId}#${event.attempt}`;
    if (event.type === "flow.finished") return "flow:finished";
    return `${event.type.replace("task.", "")}:${event.taskId}`;
  });
}

describe("taskflow", () => {
  it("runs a dependency chain in order and passes results via ctx.results", async () => {
    const flow = createFlow();
    flow.addTask({ id: "a", run: async () => 42 });
    flow.addTask({ id: "b", deps: ["a"], run: async ctx => { expect(ctx.results.get("a")).toBe(42); return "b-done"; } });
    const events = await drain(flow);
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "succeeded:a", "finished:a:succeeded",
      "ready:b", "started:b#1", "succeeded:b", "finished:b:succeeded",
      "flow:finished",
    ]);
    const last = events[events.length - 1];
    expect(last?.type === "flow.finished" && last.counts).toEqual({ succeeded: 2, failed: 0, timedOut: 0, cancelled: 0, skipped: 0 });
  });

  it("bounds concurrency, starts FIFO, and defaults concurrency to 8", async () => {
    let running = 0;
    let highWater = 0;
    const order: string[] = [];
    const flow = createFlow({ concurrency: 2 });
    for (const id of ["a", "b", "c", "d"]) {
      flow.addTask({ id, run: async () => { running += 1; highWater = Math.max(highWater, running); order.push(id); await sleep(10); running -= 1; } });
    }
    await drain(flow);
    expect(highWater).toBe(2);
    expect(order).toEqual(["a", "b", "c", "d"]);

    running = 0;
    highWater = 0;
    const wide = createFlow();
    for (let i = 0; i < 10; i += 1) {
      wide.addTask({ run: async () => { running += 1; highWater = Math.max(highWater, running); await sleep(5); running -= 1; } });
    }
    await drain(wide);
    expect(highWater).toBe(8);
  });

  it("propagates skipped down the whole downstream of a failed task", async () => {
    const flow = createFlow();
    flow.addTask({ id: "a", run: async () => { throw new Error("boom"); } });
    flow.addTask({ id: "b", deps: ["a"], run: async () => "never" });
    flow.addTask({ id: "c", deps: ["b"], run: async () => "never" });
    const events = await drain(flow);
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "finished:a:failed",
      "finished:b:skipped", "finished:c:skipped", "flow:finished",
    ]);
    const finished = events.find(event => event.type === "task.finished" && event.taskId === "a");
    expect(finished?.type === "task.finished" && (finished.error as Error).message).toBe("boom");
  });

  it("retries on failure and succeeds on the second attempt", async () => {
    let calls = 0;
    const flow = createFlow();
    flow.addTask({ id: "a", retry: { max: 2, backoffMs: 1 }, run: async () => { calls += 1; if (calls === 1) throw new Error("once"); return "ok"; } });
    const events = await drain(flow);
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "retrying:a", "ready:a", "started:a#2",
      "succeeded:a", "finished:a:succeeded", "flow:finished",
    ]);
    const retrying = events.find(event => event.type === "task.retrying");
    expect(retrying?.type === "task.retrying" && retrying.attempt).toBe(1);
  });

  it("uses defaultRetry from FlowOptions and stops when retries are exhausted or rejected", async () => {
    let calls = 0;
    const flow = createFlow({ defaultRetry: { max: 1, backoffMs: 1 } });
    flow.addTask({ id: "always", run: async () => { calls += 1; throw new Error("always"); } });
    flow.addTask({ id: "unretryable", retry: { max: 5, retryable: () => false }, run: async () => { throw new Error("nope"); } });
    const lines = shape(await drain(flow));
    expect(calls).toBe(2);
    expect(lines).toContain("started:always#2");
    expect(lines).toContain("finished:always:failed");
    expect(lines).not.toContain("started:unretryable#2");
    expect(lines).toContain("finished:unretryable:failed");
  });

  it("times out a task and consumes retry budget on timeouts", async () => {
    const flow = createFlow();
    flow.addTask({ id: "a", timeoutMs: 30, retry: { max: 1, backoffMs: 1 }, run: async ctx => { await abortableSleep(ctx.signal, 5_000); } });
    const events = await drain(flow);
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "retrying:a", "ready:a", "started:a#2", "finished:a:timedOut", "flow:finished",
    ]);
  });

  it("applies defaultTimeoutMs from FlowOptions", async () => {
    const flow = createFlow({ defaultTimeoutMs: 30 });
    flow.addTask({ id: "a", run: async ctx => { await abortableSleep(ctx.signal, 5_000); } });
    const lines = shape(await drain(flow));
    expect(lines).toContain("finished:a:timedOut");
  });

  it("cancel(taskId) aborts a running task and skips its downstream", async () => {
    let aRunning!: () => void;
    const startedA = new Promise<void>(resolve => { aRunning = resolve; });
    const flow = createFlow();
    flow.addTask({ id: "a", run: async ctx => { aRunning(); await abortableSleep(ctx.signal, 5_000); } });
    flow.addTask({ id: "b", deps: ["a"], run: async () => "never" });
    const eventsPromise = drain(flow);
    await startedA;
    flow.cancel("a");
    const events = await eventsPromise;
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "finished:a:cancelled", "finished:b:skipped", "flow:finished",
    ]);
  });

  it("cancel(taskId) on a ready task never starts it; on a pending task cancels without blocking others", async () => {
    const flow = createFlow({ concurrency: 1 });
    flow.addTask({ id: "a", run: async () => { await sleep(20); } });
    flow.addTask({ id: "b", run: async () => "never-started" });
    flow.addTask({ id: "c", deps: ["a"], run: async () => "c-done" });
    const eventsPromise = drain(flow);
    await sleep(5);                    // a running，b 在队列，c pending
    flow.cancel("b");
    flow.cancel("c");
    const lines = shape(await eventsPromise);
    expect(lines).toContain("finished:b:cancelled");
    expect(lines).toContain("finished:c:cancelled");
    expect(lines).not.toContain("started:b#1");
    expect(lines).toContain("finished:a:succeeded");
  });

  it("cancel() cancels every non-terminal task (running/ready/pending) and ends normally", async () => {
    let aRunning!: () => void;
    const startedA = new Promise<void>(resolve => { aRunning = resolve; });
    const flow = createFlow();
    flow.addTask({ id: "a", run: async ctx => { aRunning(); await abortableSleep(ctx.signal, 5_000); } });
    flow.addTask({ id: "b", run: async ctx => { await abortableSleep(ctx.signal, 5_000); } });
    flow.addTask({ id: "c", deps: ["a"], run: async () => "never" });
    const eventsPromise = drain(flow);
    await startedA;
    flow.cancel();
    const events = await eventsPromise;   // §6：正常结束，不 throw
    const statuses = Object.fromEntries(events
      .filter((event): event is Extract<TaskEvent, { type: "task.finished" }> => event.type === "task.finished")
      .map(event => [event.taskId, event.status]));
    expect(statuses).toEqual({ a: "cancelled", b: "cancelled", c: "cancelled" });
  });

  it("cancel() before run() still drains buffered events to a normal end", async () => {
    const flow = createFlow();
    flow.addTask({ id: "a", run: async () => "x" });
    flow.cancel();
    const events = await drain(flow);
    expect(shape(events)).toEqual(["ready:a", "finished:a:cancelled", "flow:finished"]);
  });

  it("supports dynamic addTask from inside a running task (grow successors)", async () => {
    const flow = createFlow();
    flow.addTask({
      id: "a",
      run: async ctx => {
        ctx.addTask({ id: "b", deps: ["a"], run: async inner => { expect(inner.results.get("a")).toBe("a-done"); return "b-done"; } });
        return "a-done";
      },
    });
    const events = await drain(flow);
    expect(shape(events)).toEqual([
      "ready:a", "started:a#1", "succeeded:a", "finished:a:succeeded",
      "ready:b", "started:b#1", "succeeded:b", "finished:b:succeeded", "flow:finished",
    ]);
  });

  it("addTask validates: unknown dep, duplicate id, self-cycle, after finish; cancel validates id; run() once", async () => {
    const flow = createFlow();
    expect(() => flow.addTask({ id: "x", deps: ["ghost"], run: async () => 0 })).toThrow(/unknown task/);
    flow.addTask({ id: "a", run: async () => 0 });
    expect(() => flow.addTask({ id: "a", run: async () => 0 })).toThrow(/duplicate/);
    expect(() => flow.addTask({ id: "loop", deps: ["loop"], run: async () => 0 })).toThrow(/cycle/);
    expect(() => flow.cancel("ghost")).toThrow(/unknown task id/);
    await drain(flow);
    expect(() => flow.addTask({ id: "late", run: async () => 0 })).toThrow(/finished/);
    expect(() => flow.run()).toThrow(/once/);
  });

  it("adding a task whose dep already failed skips it immediately; dep already succeeded runs it immediately", async () => {
    const flow = createFlow();
    // anchor 保持 flow 存活，直到晚到的任务被追加
    flow.addTask({ id: "anchor", run: async ctx => { await abortableSleep(ctx.signal, 5_000); } });
    flow.addTask({ id: "bad", run: async () => { throw new Error("x"); } });
    flow.addTask({ id: "good", run: async () => 1 });
    const eventsPromise = drain(flow);
    await sleep(20);
    flow.addTask({ id: "after-bad", deps: ["bad"], run: async () => "never" });
    flow.addTask({ id: "after-good", deps: ["good"], run: async () => "runs" });
    await sleep(20);
    flow.cancel("anchor");
    const lines = shape(await eventsPromise);
    expect(lines).toContain("finished:after-bad:skipped");
    expect(lines).toContain("finished:after-good:succeeded");
    expect(lines).toContain("finished:anchor:cancelled");
  });

  it("an empty flow finishes immediately with zero counts", async () => {
    const events = await drain(createFlow());
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "flow.finished", counts: { succeeded: 0, failed: 0, timedOut: 0, cancelled: 0, skipped: 0 } });
  });

  it("rejects invalid concurrency", () => {
    expect(() => createFlow({ concurrency: 0 })).toThrow();
  });
});
