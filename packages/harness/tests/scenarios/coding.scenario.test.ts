import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { definePlugin, taskHandlers } from "../../src/index.js";
import type { AgentEvent, AgentKernel, AgentSession, TaskHandler } from "../../src/index.js";
import { createCodingKernel } from "../fixtures/coding-runtime.js";
import { BUGGY_LINE, CodingWorkspace, FIXED_LINE, ReadBarrier } from "../fixtures/coding-workspace.js";
import { repairScript } from "../fixtures/repair-script.js";
import { ScriptedModel, toolResult } from "../fixtures/scripted-model.js";

const instruction =
  "修复商品总价计算。先读代码并运行测试，再修改源文件并重新测试，最后给出 diff 和验证结果。不得修改测试或覆盖用户已有变更。";

async function createCodingAgent(
  kernel: AgentKernel,
  sessionId: string,
  workspace: CodingWorkspace,
  barrier?: ReadBarrier,
): Promise<AgentSession> {
  const tools = workspace.tools(barrier);
  return kernel.createAgent({
    namespace: "coding-tests",
    sessionId,
    systemPrompt: "你是 Coding Agent。使用工具操作当前工作区，以真实测试结果核验修复。",
    tools,
    allowedTools: tools.map((tool) => tool.name),
  });
}

test(
  "Coding 完整场景：发现失败 → 阅读和修复 → 真实测试通过 → diff → 多轮追问，保留用户修改",
  { timeout: 30_000 },
  async (t) => {
    const cleanup = registerCleanup(t);
    const workspace = await CodingWorkspace.create();
    cleanup(() => workspace.dispose());
    const baseline = await workspace.runTests();
    assert.notEqual(baseline.exitCode, 0, "样例必须有真实缺陷");

    const model = new ScriptedModel({
      "repair-single": [
        ...repairScript("订单模块"),
        {
          check(request) {
            const history = request.messages
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n");
            assert.ok(history.includes("订单模块：已修复总价计算"), "下一轮必须保留上一轮最终回答");
            assert.ok(history.includes("刚才修改了哪个文件"), "当前用户消息必须进入模型输入");
          },
          text: "刚才只修改了 src/total.mjs 的计算逻辑，测试文件和用户备注均保留。",
        },
      ],
    });
    const kernel = await createCodingKernel(model);
    cleanup(() => kernel.dispose());
    const agent = await createCodingAgent(kernel, "repair-single", workspace);
    const events: AgentEvent[] = [];

    const result = await agent.send({
      text: instruction,
      timeoutMs: 15_000,
      onEvent: (event) => {
        events.push(event);
      },
    });
    assert.equal(result.status, "succeeded", JSON.stringify(result.error));
    assert.equal(result.text, "订单模块：已修复总价计算，3 项测试通过，原有 README 修改已保留。");
    const expectedCalls = [
      "workspace_list",
      "workspace_read",
      "tests_run",
      "workspace_patch",
      "tests_run",
      "workspace_diff",
    ];
    assert.deepEqual(workspace.calls, expectedCalls, "必须由 Loop 实际调用工具，不能凭模型文本完成任务");
    assert.deepEqual(
      result.toolCalls.map((call) => call.name),
      expectedCalls,
      "每个完整调用只执行并记录一次",
    );
    assert.ok(result.toolCalls.every((call) => call.status === "succeeded"));
    assert.equal(events.filter((event) => event.type === "run.started").length, 1);
    assert.equal(events.filter((event) => event.type === "run.finished").length, 1);
    assert.ok(events.every((event) => event.runId === result.runId && event.sessionId === agent.sessionId));
    assert.equal(events.filter((event) => event.type === "tool.started").length, 6);
    assert.equal(events.filter((event) => event.type === "tool.finished").length, 6);
    await workspace.assertRepaired();

    const followup = await agent.send({
      text: "刚才修改了哪个文件，是否覆盖了我的备注？",
      timeoutMs: 5_000,
    });
    assert.equal(followup.status, "succeeded");
    assert.notEqual(followup.runId, result.runId);
    assert.equal(followup.toolCalls.length, 0, "追问不应重复修改文件");
    assert.match(followup.text, /src\/total\.mjs/);
    model.assertConsumed();
    await agent.dispose();
  },
);

test("Coding 完整场景：两个隔离工作区并行修复 → 等待全部验证完成 → 汇总交付", { timeout: 30_000 }, async (t) => {
  const cleanup = registerCleanup(t);
  const left = await CodingWorkspace.create();
  cleanup(() => left.dispose());
  const right = await CodingWorkspace.create();
  cleanup(() => right.dispose());
  const barrier = new ReadBarrier();
  const model = new ScriptedModel({
    "repair-left": repairScript("工作区 A"),
    "repair-right": repairScript("工作区 B"),
  });
  let reviews = 0;
  const review: TaskHandler = {
    kind: "coding.review",
    version: 1,
    async execute(input, context) {
      context.signal.throwIfAborted();
      const summaries = z.object({ left: z.string(), right: z.string() }).parse(input);
      assert.match(summaries.left, /工作区 A/);
      assert.match(summaries.right, /工作区 B/);
      assert.equal(left.calls.at(-1), "workspace_diff", "汇总不得早于 A 完成验证");
      assert.equal(right.calls.at(-1), "workspace_diff", "汇总不得早于 B 完成验证");
      await Promise.all([left.assertRepaired(), right.assertRepaired()]);
      reviews += 1;
      return {
        repairedWorkspaces: 2,
        summary: `${summaries.left}\n${summaries.right}`,
      };
    },
  };
  const reviewPlugin = definePlugin({
    manifest: {
      id: "test.coding-review",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: ["task.engine"],
      provides: [],
      contributes: ["task.handler"],
    },
    setup(context) {
      context.contribute(taskHandlers, review);
    },
  });
  const kernel = await createCodingKernel(model, [reviewPlugin]);
  cleanup(() => kernel.dispose());
  await createCodingAgent(kernel, "repair-left", left, barrier);
  await createCodingAgent(kernel, "repair-right", right, barrier);
  const deadlineAt = Date.now() + 20_000;
  const flow = kernel.tasks.submitFlow({
    deadlineAt,
    maxConcurrency: 2,
    outputNode: "review",
    nodes: [
      {
        id: "fix-left",
        task: {
          kind: "agent.send",
          version: 1,
          input: {
            namespace: "coding-tests",
            sessionId: "repair-left",
            text: instruction,
          },
          concurrencyKey: "workspace:left",
          deadlineAt,
        },
      },
      {
        id: "fix-right",
        task: {
          kind: "agent.send",
          version: 1,
          input: {
            namespace: "coding-tests",
            sessionId: "repair-right",
            text: instruction,
          },
          concurrencyKey: "workspace:right",
          deadlineAt,
        },
      },
      {
        id: "review",
        dependsOn: ["fix-left", "fix-right"],
        task: { kind: "coding.review", version: 1, input: {}, deadlineAt },
        inputBindings: {
          left: { nodeId: "fix-left", path: ["text"] },
          right: { nodeId: "fix-right", path: ["text"] },
        },
      },
    ],
  });
  const result = await flow.result();
  assert.equal(result.status, "succeeded", JSON.stringify(result.nodes));
  assert.equal(reviews, 1, "汇总节点只执行一次");
  assert.equal(barrier.arrivals, 2);
  assert.equal(barrier.peak, 2, "必须实际重叠执行两个工作区，而非顺序运行伪装并发");
  assert.equal(barrier.active, 0);
  assert.ok(Object.values(result.nodes).every((node) => node.status === "succeeded"));
  assert.equal(z.object({ repairedWorkspaces: z.number() }).parse(result.output).repairedWorkspaces, 2);
  assert.equal(left.calls.filter((name) => name === "workspace_patch").length, 1);
  assert.equal(right.calls.filter((name) => name === "workspace_patch").length, 1);
  model.assertConsumed();
  await kernel.tasks.drain({ timeoutMs: 2_000 });
});

test("Coding 完整场景：排队修复 → 取消长测试进程 → 保留补丁 → 同会话继续验证", { timeout: 30_000 }, async (t) => {
  const cleanup = registerCleanup(t);
  const workspace = await CodingWorkspace.create();
  cleanup(() => workspace.dispose());
  workspace.blockNextTestsUntilCancelled();
  const model = new ScriptedModel({
    "repair-cancel": [
      { tool: { name: "workspace_read", input: { path: "src/total.mjs" } } },
      {
        check(request) {
          assert.ok(
            z.object({ content: z.string() }).parse(toolResult(request, "workspace_read")).content.includes(BUGGY_LINE),
          );
        },
        tool: {
          name: "workspace_patch",
          input: {
            path: "src/total.mjs",
            before: BUGGY_LINE,
            after: FIXED_LINE,
          },
        },
      },
      { tool: { name: "tests_run", input: {} } },
      {
        check(request) {
          const parts = request.messages.flatMap((message) => message.parts);
          const cancelled = parts.findLast((part) => part.type === "tool-result" && part.name === "tests_run");
          assert.ok(
            cancelled?.type === "tool-result" && cancelled.status === "failed",
            "被取消调用也要闭合配对，不得留下缺结果的历史",
          );
        },
        tool: { name: "tests_run", input: {} },
      },
      {
        check(request) {
          assert.equal(z.object({ exitCode: z.number() }).parse(toolResult(request, "tests_run")).exitCode, 0);
        },
        text: "已保留补丁并重新验证，3 项测试通过。",
      },
    ],
  });
  const kernel = await createCodingKernel(model);
  cleanup(() => kernel.dispose());
  const agent = await createCodingAgent(kernel, "repair-cancel", workspace);
  const task = kernel.tasks.submit({
    kind: "agent.send",
    version: 1,
    input: {
      namespace: "coding-tests",
      sessionId: agent.sessionId,
      text: instruction,
    },
    concurrencyKey: "workspace:cancel",
    deadlineAt: Date.now() + 15_000,
  });

  await waitForStart(workspace.testsStarted.promise, AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]));
  assert.equal(workspace.activeProcessCount, 1);
  task.cancel("用户取消长测试");
  const cancelled = await task.result();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(workspace.activeProcessCount, 0, "取消完成前必须停止真实子进程");
  assert.ok((await workspace.read("src/total.mjs")).includes(FIXED_LINE), "取消不回滚已经完成的文件修改");
  assert.equal(model.requests.length, 3, "取消后不能继续调用模型");

  const result = await agent.send({
    text: "继续，保留补丁，只重新运行测试。",
    timeoutMs: 8_000,
  });
  assert.equal(result.status, "succeeded", JSON.stringify(result.error));
  assert.match(result.text, /3 项测试通过/);
  assert.equal(workspace.calls.filter((name) => name === "workspace_patch").length, 1);
  assert.equal(workspace.activeProcessCount, 0);
  await workspace.assertRepaired();
  model.assertConsumed();
  await agent.dispose();
});

async function waitForStart(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("Coding 测试进程未在截止时间内启动"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function registerCleanup(t: TestContext) {
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    const errors: unknown[] = [];
    // 内核先退出，才能删除它持有的工作区；每一项清理都会尝试执行。
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Coding 场景资源清理失败");
  });
  return (cleanup: () => Promise<void>) => {
    cleanups.push(cleanup);
  };
}
