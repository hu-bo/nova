import { execFile } from "node:child_process";
import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createModel } from "@nova/model-adapters";
import { createTestRuntime } from "./test-runtime.js";

const live = process.env.NOVA_TEST_LIVE === "1";
const execFileAsync = promisify(execFile);

it.skipIf(!live)(
  "真实模型自主完成复杂 coding 修复闭环",
  async () => {
    loadEnvFileOverride(fileURLToPath(new URL("../../../.env", import.meta.url)));
    const apiKey = process.env.OPENAI_API_KEY;
    const modelName = process.env.MODEL;
    if (!apiKey || !modelName) throw new Error("OPENAI_API_KEY and MODEL are required in .env");

    const modelRef = {
      provider: "openai" as const,
      model: modelName,
      apiKey,
      ...(process.env.OPENAI_BASE_URL ? { baseUrl: process.env.OPENAI_BASE_URL } : {}),
    };
    const model = createModel(modelRef);
    const harness = await createTestRuntime({
      model: modelRef,
      stream: model.stream,
      maxTurns: 20,
      decide: async (request) =>
        request.kind === "approval"
          ? { kind: "approval", decision: "allow" }
          : { kind: "question", answers: ["只修改 src 下的实现，不修改测试"] },
    });

    try {
      await writeFile(
        join(harness.workspace!, "package.json"),
        JSON.stringify({ type: "module", scripts: { test: "node test.js" } }, null, 2),
      );
      const { mkdir } = await import("node:fs/promises");

      await mkdir(join(harness.workspace!, "src"));
      await writeFile(
        join(harness.workspace!, "src", "cart.js"),
        [
          "export function total(items, discountPercent) {",
          "  const subtotal = items.reduce((sum, item) => sum + item.price, 0);",
          "  const discount = subtotal * discountPercent;",
          "  return Math.round(discount * 100) / 100;",
          "}",
        ].join("\n"),
      );
      await writeFile(
        join(harness.workspace!, "test.js"),
        [
          `import { total } from "./src/cart.js";`,
          `const cases = [`,
          `  { items: [{ price: 12.5, quantity: 2 }, { price: 5, quantity: 1 }], discount: 10, want: 27 },`,
          `  { items: [{ price: 19.99, quantity: 3 }], discount: 0, want: 59.97 },`,
          `  { items: [], discount: 25, want: 0 },`,
          `];`,
          `for (const value of cases) {`,
          `  const got = total(value.items, value.discount);`,
          `  if (got !== value.want) throw new Error(JSON.stringify({ got, want: value.want }));`,
          `}`,
          `console.log("PASS");`,
        ].join("\n"),
      );

      const result = await harness.agent.prompt(
        "这个购物车计价项目有多个关联 bug。请先建立 TODO，读取代码并运行测试定位所有根因；只修改 src 下实现，反复运行 npm test 直到通过，再检查改动并总结。",
      );
      const verification = await execFileAsync("node", ["test.js"], { cwd: harness.workspace! });
      const records = await harness.storage.loadRecords(harness.agent.sessionId);
      const toolNames = records.filter((record) => record.kind === "tool-started").map((record) => record.name);
      const todoUpdates = records.filter((record) => record.kind === "todo-updated");
      expect(result.stopReason, result.errorMessage).toBe("done");
      expect(verification.stdout.trim()).toBe("PASS");
      expect(toolNames).toContain("read_file");
      expect(toolNames).toContain("bash");
      expect(toolNames.some((name) => name === "edit_file" || name === "write_file")).toBe(true);
      expect(todoUpdates.length).toBeGreaterThan(0);
      expect(
        todoUpdates.at(-1)?.kind === "todo-updated" &&
          todoUpdates.at(-1)?.items.every((item) => item.status === "completed"),
      ).toBe(true);
    } finally {
      await harness.cleanup();
    }
  },
  180_000,
);

function loadEnvFileOverride(path: string): void {
  loadEnvFile(path);
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
