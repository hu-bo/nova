// Coding 层只保留完整闭环；Agent 的审批、TODO、批处理、压缩和恢复语义由 agent-core 就近测试。
import { expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { toToolContext } from "@nova/runner-sdk";
import { createTestRuntime, replay, toolResults, startRunner } from "./test-runtime.js";

it("录制模型完成读代码、失败测试、反问、修复、复测与交付闭环", async () => {
  const harness = await createTestRuntime({
    stream: replay("fix-bug-loop"),
    decide: async (request) =>
      request.kind === "question"
        ? { kind: "question", answers: ["sum.js 的实现"] }
        : { kind: "approval", decision: "allow" },
  });
  try {
    await writeFile(
      join(harness.workspace!, "sum.js"),
      "function sum(a, b) {\n  return a - b;\n}\nmodule.exports = { sum };\n",
    );
    await writeFile(
      join(harness.workspace!, "test.js"),
      [
        `const { sum } = require("./sum.js");`,
        "const got = sum(2, 3);",
        "if (got !== 5) { console.log(`FAIL: sum(2,3) = ${got}`); process.exit(1); }",
        `console.log("PASS");`,
      ].join("\n"),
    );

    const result = await harness.agent.prompt("test.js 跑不过了，帮我修");
    const entries = await harness.storage.loadEntries(harness.agent.sessionId);
    const executions = toolResults(entries).filter(
      (item) => item.text.startsWith("FAIL") || item.text.startsWith("PASS"),
    );
    const records = await harness.storage.loadRecords(harness.agent.sessionId);
    const todos = records.filter((record) => record.kind === "todo-updated");

    expect(result.stopReason).toBe("done");
    expect(result.message?.blocks.some((block) => block.type === "text" && block.text.includes("修复完成"))).toBe(true);
    expect(executions.map((item) => item.text.trim())).toEqual(["FAIL: sum(2,3) = -1", "PASS"]);
    expect(harness.decisions.some((decision) => decision.kind === "approval")).toBe(true);
    expect(harness.decisions.some((decision) => decision.kind === "question")).toBe(true);
    expect(records.filter((record) => record.kind === "tool-started").length).toBeGreaterThanOrEqual(5);
    expect(todos.length).toBeGreaterThanOrEqual(2);
    expect(
      todos.at(-1)?.kind === "todo-updated" && todos.at(-1)?.items.every((item) => item.status === "completed"),
    ).toBe(true);
    expect(await readFile(join(harness.workspace!, "sum.js"), "utf8")).toContain("a + b");
  } finally {
    await harness.cleanup();
  }
}, 30_000);

it("git config --file .gitmodules --list returns Finished without timing out", async () => {
  const runner = await startRunner();
  try {
    await writeFile(join(runner.workspace, ".gitmodules"), '[submodule "demo"]\n\tpath = packages/demo\n');
    const context = toToolContext(runner.session, { cwd: runner.workspace });
    for (let i = 0; i < 20; i += 1) {
      const result = await context.exec("git", {
        args: ["config", "--file", ".gitmodules", "--list"],
        timeoutMs: 10_000,
      });
      expect(result).toEqual({
        ok: true,
        value: expect.objectContaining({
          exitCode: 0,
          stdout: "submodule.demo.path=packages/demo\n",
        }),
      });
    }
  } finally {
    runner.process.kill();
    await runner.sdk.close();
  }
}, 30_000);
