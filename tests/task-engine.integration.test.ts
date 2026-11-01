import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createAgentKernel, definePlugin, taskHandlers } from "../src/index.js";
import type { TaskHandler } from "../src/index.js";
import { memoryTaskStorePlugin } from "../src/plugins/task-store-memory/index.js";
import { memoryTaskQueuePlugin } from "../src/plugins/queue-memory/index.js";
import { taskEnginePlugin } from "../src/plugins/task-engine/index.js";
import { FrameworkError } from "../src/contracts/errors.js";

async function runtime(
  handlers: readonly TaskHandler[],
  limit = 4,
  pending = 200,
) {
  return createAgentKernel({
    maxConcurrentRuns: 4,
    configure: async (ctx) => {
      await ctx.plugin(
        memoryTaskStorePlugin({ maxTasks: 500, completedTtlMs: 1_000 }),
      );
      await ctx.plugin(memoryTaskQueuePlugin({ maxPending: pending }));
      await ctx.plugin(
        taskEnginePlugin({
          maxConcurrentTasks: limit,
          maxConcurrentPerKey: 1,
          maxNodesPerFlow: 100,
          retry: { baseDelayMs: 5, maxDelayMs: 10 },
        }),
      );
      await ctx.plugin(
        definePlugin({
          manifest: {
            id: "test.tasks",
            version: "1.0.0",
            apiVersion: 1,
            scope: "kernel",
            requires: ["task.engine"],
            provides: [],
            contributes: ["task.handler"],
          },
          setup(context) {
            for (const handler of handlers)
              context.contribute(taskHandlers, handler);
          },
        }),
      );
    },
  });
}
test("100 Tasks respect actual concurrency 4, keys, acceptance capacity and idempotency", async () => {
  let active = 0;
  let peak = 0;
  const keys = new Set<string>();
  const kernel = await runtime([
    {
      kind: "work",
      version: 1,
      async execute(input) {
        const key = JSON.stringify(input);
        assert.equal(keys.has(key), false);
        keys.add(key);
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active--;
        keys.delete(key);
        return input;
      },
    },
  ]);
  try {
    const deadlineAt = Date.now() + 10_000;
    const tasks = Array.from({ length: 100 }, (_, index) =>
      kernel.tasks.submit({
        kind: "work",
        version: 1,
        input: index % 8,
        concurrencyKey: String(index % 8),
        deadlineAt,
      }),
    );
    assert.ok(
      (await Promise.all(tasks.map((task) => task.result()))).every(
        (result) => result.status === "succeeded",
      ),
    );
    assert.equal(peak, 4);
    assert.equal(active, 0);
    const spec = {
      kind: "work",
      version: 1,
      input: "dedup",
      deadlineAt,
      idempotencyKey: "same",
    };
    const first = kernel.tasks.submit(spec);
    assert.strictEqual(kernel.tasks.submit(spec), first);
    assert.throws(() => kernel.tasks.submit({ ...spec, input: "different" }), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    await first.result();
  } finally {
    await kernel.dispose();
  }
  const bounded = await runtime(
    [
      {
        kind: "work",
        version: 1,
        async execute() {
          return null;
        },
      },
    ],
    1,
    1,
  );
  try {
    const queued = bounded.tasks.submit({
      kind: "work",
      version: 1,
      input: null,
      notBefore: Date.now() + 500,
      deadlineAt: Date.now() + 5_000,
    });
    assert.throws(
      () =>
        bounded.tasks.submit({
          kind: "work",
          version: 1,
          input: null,
          deadlineAt: Date.now() + 5_000,
        }),
      { code: "QUEUE_FULL" },
    );
    queued.cancel();
    assert.equal((await queued.result()).status, "cancelled");
  } finally {
    await bounded.dispose();
  }
});

test("early signal resumes once without repeating execute; safe retries respect attempts", async () => {
  let executions = 0;
  let resumptions = 0;
  let attempts = 0;
  const kernel = await runtime(
    [
      {
        kind: "external",
        version: 1,
        protocol: "outcome",
        async execute(_, context) {
          executions++;
          const waitId = context.createWait({ expiresAt: context.deadlineAt });
          const signal = {
            taskId: context.taskId,
            waitId,
            eventId: "result",
            payload: 42,
          };
          assert.equal(kernel.tasks.signal(signal).status, "accepted");
          assert.equal(kernel.tasks.signal(signal).status, "duplicate");
          return {
            kind: "waiting",
            waitId,
            state: { submitted: true },
            expiresAt: context.deadlineAt,
          };
        },
        async resume(state, signal) {
          resumptions++;
          assert.deepEqual(state, { submitted: true });
          return { kind: "completed", output: signal.payload };
        },
      },
      {
        kind: "retry",
        version: 1,
        retrySafe: true,
        async execute() {
          if (++attempts < 3)
            throw new FrameworkError(
              "TRANSIENT",
              "Retryable fixture failure",
              true,
            );
          return attempts;
        },
      },
    ],
    1,
  );
  try {
    const external = kernel.tasks.submit({
      kind: "external",
      version: 1,
      input: null,
      deadlineAt: Date.now() + 5_000,
    });
    assert.equal((await external.result()).output, 42);
    assert.equal(executions, 1);
    assert.equal(resumptions, 1);
    const retry = kernel.tasks.submit({
      kind: "retry",
      version: 1,
      input: null,
      maxAttempts: 3,
      deadlineAt: Date.now() + 5_000,
    });
    assert.equal((await retry.result()).status, "succeeded");
    assert.equal(attempts, 3);
    assert.equal(retry.snapshot().attempts, 3);
  } finally {
    await kernel.dispose();
  }
});

test("flows bind completed outputs, respect fan-out concurrency and retain node results", async () => {
  let active = 0;
  let peak = 0;
  const kernel = await runtime(
    [
      {
        kind: "produce",
        version: 1,
        async execute(input) {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active--;
          return { value: input };
        },
      },
      {
        kind: "join",
        version: 1,
        async execute(input) {
          const joined = z
            .object({
              left: z.object({ value: z.string() }),
              right: z.object({ value: z.string() }),
            })
            .parse(input);
          return `${joined.left.value}+${joined.right.value}`;
        },
      },
    ],
    4,
  );
  try {
    const flow = kernel.tasks.submitFlow({
      nodes: [
        {
          id: "left",
          task: {
            kind: "produce",
            version: 1,
            input: "left",
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "right",
          task: {
            kind: "produce",
            version: 1,
            input: "right",
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "join",
          dependsOn: ["left", "right"],
          task: {
            kind: "join",
            version: 1,
            input: { left: null, right: null },
            deadlineAt: Date.now() + 5_000,
          },
          inputBindings: {
            left: { nodeId: "left", path: [] },
            right: { nodeId: "right", path: [] },
          },
        },
      ],
      outputNode: "join",
      deadlineAt: Date.now() + 5_000,
      maxConcurrency: 2,
    });
    const result = await flow.result();
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.output, "left+right");
    assert.equal(Object.keys(result.nodes).length, 3);
    assert.equal(peak, 2);
  } finally {
    await kernel.dispose();
  }
});

test("flow fail-fast cancels active nodes and skips blocked dependents", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const kernel = await runtime(
    [
      {
        kind: "fail",
        version: 1,
        async execute() {
          throw new FrameworkError("FIXTURE", "expected failure");
        },
      },
      {
        kind: "slow",
        version: 1,
        async execute(_, context) {
          await gate;
          context.signal.throwIfAborted();
          return "unexpected";
        },
      },
      {
        kind: "never",
        version: 1,
        async execute() {
          return "unexpected";
        },
      },
    ],
    2,
  );
  try {
    const flow = kernel.tasks.submitFlow({
      nodes: [
        {
          id: "failure",
          task: {
            kind: "fail",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "slow",
          task: {
            kind: "slow",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "dependent",
          dependsOn: ["failure"],
          task: {
            kind: "never",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
      ],
      outputNode: "dependent",
      deadlineAt: Date.now() + 5_000,
      maxConcurrency: 2,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    const result = await flow.result();
    assert.equal(result.status, "failed");
    assert.equal(result.nodes.failure?.status, "failed");
    assert.equal(result.nodes.dependent?.status, "skipped");
    assert.equal(result.nodes.slow?.status, "cancelled");
  } finally {
    await kernel.dispose();
  }
});

test("any-success joins the first successful branch after cancelling losers", async () => {
  let slowStarted!: () => void;
  const slowStartedPromise = new Promise<void>((resolve) => {
    slowStarted = resolve;
  });
  const kernel = await runtime(
    [
      {
        kind: "fast",
        version: 1,
        async execute() {
          return "winner";
        },
      },
      {
        kind: "slow",
        version: 1,
        async execute(_, context) {
          slowStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          context.signal.throwIfAborted();
          return "loser";
        },
      },
      {
        kind: "join",
        version: 1,
        async execute() {
          return "joined";
        },
      },
    ],
    2,
  );
  try {
    const flow = kernel.tasks.submitFlow({
      nodes: [
        {
          id: "fast",
          task: {
            kind: "fast",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "slow",
          task: {
            kind: "slow",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "joined",
          dependsOn: ["fast", "slow"],
          join: "any-success",
          task: {
            kind: "join",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
      ],
      outputNode: "joined",
      deadlineAt: Date.now() + 5_000,
      maxConcurrency: 2,
    });
    await slowStartedPromise;
    const result = await flow.result();
    assert.equal(result.status, "succeeded");
    assert.equal(result.output, "joined");
    assert.equal(result.nodes.fast?.status, "succeeded");
    assert.equal(result.nodes.slow?.status, "cancelled");
    assert.equal(result.nodes.joined?.status, "succeeded");
  } finally {
    await kernel.dispose();
  }
});

test("any-success waits through failed candidates until a branch succeeds", async () => {
  const kernel = await runtime(
    [
      {
        kind: "failed-candidate",
        version: 1,
        async execute() {
          throw new FrameworkError("CANDIDATE_FAILED", "candidate failed");
        },
      },
      {
        kind: "successful-candidate",
        version: 1,
        async execute() {
          await new Promise<void>((resolve) => setImmediate(resolve));
          return "winner";
        },
      },
      {
        kind: "join",
        version: 1,
        async execute() {
          return "joined";
        },
      },
    ],
    2,
  );
  try {
    const flow = kernel.tasks.submitFlow({
      nodes: [
        {
          id: "failed",
          task: {
            kind: "failed-candidate",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "successful",
          task: {
            kind: "successful-candidate",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
        {
          id: "joined",
          dependsOn: ["failed", "successful"],
          join: "race",
          task: {
            kind: "join",
            version: 1,
            input: null,
            deadlineAt: Date.now() + 5_000,
          },
        },
      ],
      outputNode: "joined",
      deadlineAt: Date.now() + 5_000,
      maxConcurrency: 2,
    });
    const result = await flow.result();
    assert.equal(result.status, "succeeded", JSON.stringify(result));
    assert.equal(result.nodes.failed?.status, "failed");
    assert.equal(result.nodes.successful?.status, "succeeded");
    assert.equal(result.output, "joined");
  } finally {
    await kernel.dispose();
  }
});

test("parent child waits release the execution slot and propagate cancellation", async () => {
  let childStarted!: () => void;
  const childStartedPromise = new Promise<void>((resolve) => {
    childStarted = resolve;
  });
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => {
    releaseChild = resolve;
  });
  const kernel = await runtime(
    [
      {
        kind: "child",
        version: 1,
        async execute(_, context) {
          childStarted();
          await childGate;
          context.signal.throwIfAborted();
          return "child-result";
        },
      },
      {
        kind: "parent",
        version: 1,
        async execute(_, context) {
          const child = context.submitChild({
            kind: "child",
            version: 1,
            input: null,
            deadlineAt: context.deadlineAt,
          });
          const result = await context.waitFor(child);
          return result.output ?? null;
        },
      },
    ],
    1,
  );
  try {
    const parent = kernel.tasks.submit({
      kind: "parent",
      version: 1,
      input: null,
      deadlineAt: Date.now() + 5_000,
    });
    await childStartedPromise;
    assert.equal(parent.snapshot().status, "running");
    releaseChild();
    const result = await parent.result();
    assert.deepEqual(result, {
      taskId: parent.taskId,
      status: "succeeded",
      output: "child-result",
    });
  } finally {
    await kernel.dispose();
  }

  let cancellationChildStarted!: () => void;
  const cancellationChildStartedPromise = new Promise<void>((resolve) => {
    cancellationChildStarted = resolve;
  });
  const cancellationKernel = await runtime(
    [
      {
        kind: "child",
        version: 1,
        async execute(_, context) {
          cancellationChildStarted();
          await new Promise<void>((resolve) => {
            context.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
          context.signal.throwIfAborted();
          return "unreachable";
        },
      },
      {
        kind: "parent",
        version: 1,
        async execute(_, context) {
          const child = context.submitChild({
            kind: "child",
            version: 1,
            input: null,
            deadlineAt: context.deadlineAt,
          });
          const result = await context.waitFor(child);
          return result.status;
        },
      },
    ],
    1,
  );
  try {
    const parent = cancellationKernel.tasks.submit({
      kind: "parent",
      version: 1,
      input: null,
      deadlineAt: Date.now() + 5_000,
    });
    await cancellationChildStartedPromise;
    parent.cancel();
    assert.equal((await parent.result()).status, "cancelled");
  } finally {
    await cancellationKernel.dispose();
  }
});
