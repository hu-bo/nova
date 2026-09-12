import { execFile } from "node:child_process";
import { loadEnvFile } from "node:process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createModel, estimateText } from "@nova/model-adapters";
import type { ModelRef, ThinkingLevel } from "@nova/model-adapters";
import { createTestRuntime } from "./test-runtime.js";

const live = process.env.NOVA_TEST_LIVE === "1";
const execFileAsync = promisify(execFile);

it.skipIf(!live)(
  "真实模型自主完成复杂 coding 修复闭环",
  async () => {
    const modelRef = liveModelRef();
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

// —— 糖果题评测（原 codex_candy_eval.py 的 JS 版）——
// 只保留题目、token/耗时统计和判分：请求直接走模型适配层的单轮 stream，不挂任何工具，
// 因此模型只能靠 reasoning 解题。轮数用 CANDY_EVAL_RUNS、推理档位用 CANDY_EVAL_EFFORT、
// 模型组用 CANDY_EVAL_PROVIDER（openai / anthropic，默认 anthropic）控制。

const CANDY_PROMPT = `在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4
`;

// 正确答案为 21：回答中出现独立的 "21"（前后非数字）即判为正确。
// 口径与原 py 脚本一致，只看阿拉伯数字，因此"二十一个"这类写法会被判错。
const ANSWER_PATTERN = /(?<!\d)21(?!\d)/;
const CANDY_TIMEOUT_MS = 200_000;
const candyRuns = Number(process.env.CANDY_EVAL_RUNS ?? 1);

it.skipIf(!live)(
  `真实模型解糖果题（${candyRuns} 轮）：统计 token 与耗时并判分`,
  async () => {
    const modelRef = liveModelRef(candyProvider());
    const thinking = (process.env.CANDY_EVAL_EFFORT ?? "high") as ThinkingLevel;
    const runs: CandyRun[] = [];
    for (const run of Array.from({ length: candyRuns }, (_, index) => index + 1)) {
      const result = await askCandy(modelRef, thinking);
      const score: CandyRun = { ...result, run, correct: ANSWER_PATTERN.test(result.text) };
      runs.push(score);
      // 逐轮打印，串行评测时能立刻看到进度和某一轮卡住的位置。
      console.log(
        `Run ${run}  ${score.inputTokens} in / ${score.outputTokens} out / ${score.reasoningTokens} reason  ` +
          `${score.seconds.toFixed(1)}s  ${score.tps.toFixed(1)} tok/s  ${score.correct ? "✓" : "✗"}`,
      );
      // 表格里的回答是截断预览；判分存疑时用 CANDY_EVAL_DEBUG=1 打出全文核对。
      if (process.env.CANDY_EVAL_DEBUG) console.log(`--- Run ${run} answer ---\n${score.text}\n--- end ---`);
    }
    console.log(`\n${formatCandyTable(runs, candyRuns)}`);
    for (const score of runs) {
      expect(score.text.trim(), `Run ${score.run} 未返回最终回答`).not.toBe("");
      expect(score.outputTokens, `Run ${score.run} 未返回 usage`).toBeGreaterThan(0);
    }
    // 正确率只做统计不做断言：真实模型解题不稳定，硬断言会让 live 测试随机失败。
  },
  candyRuns * (CANDY_TIMEOUT_MS + 40_000),
);

/** `.env` 里两组供应商配置各带一个 MODEL；评测按组切换，不假设哪一组可达。 */
type LiveProvider = "openai" | "anthropic";

// 默认取 ANTHROPIC_* 那组（阿里云 MaaS 的 qwen）：OPENAI_* 指向的网关在本机可能被 WAF 拦截。
function candyProvider(): LiveProvider {
  const value = process.env.CANDY_EVAL_PROVIDER;
  if (value === undefined || value === "anthropic") return "anthropic";
  if (value === "openai") return "openai";
  throw new Error(`CANDY_EVAL_PROVIDER 取值非法: ${value}（允许 openai | anthropic）`);
}

interface CandyRun {
  run: number;
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** reasoning 部分单独估算：Usage 里的 output 已含 reasoning，thinking 文本量才反映推理开销。 */
  reasoningTokens: number;
  seconds: number;
  tps: number;
  correct: boolean;
}

async function askCandy(
  modelRef: ModelRef,
  thinking: ThinkingLevel,
): Promise<Omit<CandyRun, "run" | "correct">> {
  let text = "";
  let reasoning = "";
  let usage = { input: 0, output: 0 };
  let stopReason: string | undefined;
  const started = performance.now();
  const request = {
    system: "只回答用户提出的问题，不要调用任何工具。",
    tools: [],
    thinking,
    messages: [
      {
        id: "candy-eval",
        role: "user" as const,
        createdAt: Date.now(),
        blocks: [{ type: "text" as const, text: CANDY_PROMPT }],
      },
    ],
  };
  try {
    for await (const event of createModel(modelRef).stream(request, AbortSignal.timeout(CANDY_TIMEOUT_MS))) {
      if (event.type === "block.end" && event.block.type === "text") text = event.block.text;
      else if (event.type === "block.end" && event.block.type === "thinking") reasoning = event.block.text;
      else if (event.type === "usage") usage = { input: event.usage.input, output: event.usage.output };
      else if (event.type === "finish") {
        stopReason = event.stopReason;
        if (event.stopReason === "error") throw new Error(`模型调用失败: ${event.errorMessage ?? "unknown error"}`);
      }
    }
  } catch (error) {
    // AbortSignal.timeout 抛 TimeoutError，转成评测语境下的报错，便于区分慢和挂。
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error(`模型调用超时（${CANDY_TIMEOUT_MS}ms）`);
    }
    throw error;
  }
  if (!stopReason) throw new Error("模型未返回 finish 事件");
  const seconds = (performance.now() - started) / 1000;
  return {
    text,
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningTokens: reasoning ? estimateText(reasoning).tokens : 0,
    seconds,
    tps: seconds > 0 ? usage.output / seconds : 0,
  };
}

function formatCandyTable(runs: CandyRun[], total: number): string {
  const headers = ["Run", "In Tok", "Out Tok", "Reason Tok", "Time(s)", "TPS", "OK", "Answer"];
  const rows = runs.map((run) => [
    String(run.run),
    String(run.inputTokens),
    String(run.outputTokens),
    String(run.reasoningTokens),
    run.seconds.toFixed(1),
    run.tps ? run.tps.toFixed(1) : "-",
    run.correct ? "✓" : "✗",
    preview(run.text, 48),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]))),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - displayWidth(cell)))).join("  ").trimEnd();
  const correct = runs.filter((run) => run.correct).length;
  const accuracy = runs.length ? `  accuracy=${((correct / runs.length) * 100).toFixed(1)}%` : "";
  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
    "",
    `Graded ${runs.length}/${total}  correct=${correct}${accuracy}`,
  ].join("\n");
}

/** 中文回答按显示宽度截断，避免把表格撑歪。 */
function preview(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (displayWidth(flat) <= limit) return flat;
  let result = "";
  for (const char of flat) {
    if (displayWidth(result) + displayWidth(char) > limit - 3) break;
    result += char;
  }
  return `${result}...`;
}

/** CJK 字符和全角标点在终端占 2 列，其余 1 列。 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char)
      ? 2
      : 1;
  }
  return width;
}

/** 从根 `.env` 取一个真实模型的接入配置；provider 决定读 OPENAI_* 还是 ANTHROPIC_* 那组变量。 */
function liveModelRef(provider: LiveProvider = "anthropic"): ModelRef {
  loadEnvFileOverride(fileURLToPath(new URL("../../../.env", import.meta.url)));
  const apiKey = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  const model = (provider === "anthropic" ? process.env.ANTHROPIC_MODEL : undefined) ?? process.env.MODEL;
  const baseUrl = provider === "anthropic" ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL;
  if (!apiKey || !model) throw new Error(`${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} and MODEL are required in .env`);
  return {
    provider,
    model,
    apiKey,
    ...(baseUrl ? { baseUrl } : {}),
    ...(provider === "openai" && process.env.MODEL_WIRE_API
      ? { wireApi: process.env.MODEL_WIRE_API as ModelRef["wireApi"] }
      : {}),
  };
}

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
