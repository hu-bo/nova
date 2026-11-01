#!/usr/bin/env node
/**
 * 糖果题评测脚本：验证 packages/harness 的真实模型调用链路。
 *
 * 用法：
 *   node example/candy-eval.mjs                 跑 harness 1 轮
 *   node example/candy-eval.mjs --ab -n 5       baseline / guided 各跑 5 轮
 *   node example/candy-eval.mjs --check         只预检依赖与 .env，不发请求
 *
 * 通过 @nnova/harness 的 createAgentKernel + agent.send 跑单轮模型请求，tools 为空；
 * 当前 Harness 的 AI SDK 插件使用 OpenAI Chat Completions 协议。
 *
 * --ab 再加一组"解题引导" system prompt（逐条复述约束 + 双向证明，不含答案），
 * 与 baseline 各跑 -n 轮并排对比，用来判断答错是"疏忽型"（能被通用引导救回）还是
 * "预算被掐型"（引导也救不动，通常是网关降智/额度问题）。
 *
 * 脚本使用 Harness 的构建产物，不依赖 vitest 或其它模型适配包。
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
// 题面与判分口径的唯一来源，与 codex_candy_eval.mjs 共用，避免两边各自漂移。
import {
  ANSWER_PATTERN,
  CANDY_QUESTION as CANDY_PROMPT,
  NO_TOOL_INSTRUCTION as SYSTEM_PROMPT,
} from "./candy-prompt.mjs";

const DEFAULT_TIMEOUT_MS = 600_000;
const TARGETS = ["harness"];
const EFFORTS = ["low", "medium", "xhigh"];

/**
 * A/B 的两个提示词变体。guided 只在 baseline 之上追加**通用解题自检**：
 * 逐条复述约束（含看似次要的措辞）、判定问题类型、要求"该数目一定够"与
 * "少一个存在反例"双向证明。刻意不含答案数字、也不点破"形状可凭手感自选"
 * 这个题眼——考的是脚手架能否逼模型自己注意到约束，而不是背答案。
 */
const GUIDANCE =
  "在给出最终数字前，先按下面步骤自检，再作答：\n" +
  "1. 逐条列出题目里的所有约束条件和数据，特别注意看似次要的描述（例如关于“手感”“可分辨”“随机”“保证”的措辞）各自限制了什么；\n" +
  "2. 判断这是“随机抽取型”还是“可按属性定向选择型”问题，并说明依据；\n" +
  "3. 主张一个最小数目后，必须同时给出两面：该数目一定满足要求，且少一个数目存在某种取法不满足要求（构造反例）；\n" +
  "4. 若两面凑不齐，回去修正答案，不要将就给出结论。";
const VARIANTS = {
  baseline: SYSTEM_PROMPT,
  guided: `${SYSTEM_PROMPT}\n\n${GUIDANCE}`,
};
const VARIANT_NAMES = ["baseline", "guided"];


const REPO_ROOT = new URL("../", import.meta.url);
const HARNESS_ENTRY = new URL("packages/harness/dist/index.js", REPO_ROOT);
const HARNESS_MODEL_ENTRY = new URL("packages/harness/dist/plugins/model-ai-sdk/index.js", REPO_ROOT);
const HARNESS_LOOP_ENTRY = new URL("packages/harness/dist/plugins/basic-loop/index.js", REPO_ROOT);
const HARNESS_CONTEXT_ENTRY = new URL("packages/harness/dist/plugins/context/index.js", REPO_ROOT);
const HARNESS_SESSION_ENTRY = new URL("packages/harness/dist/plugins/session-memory/index.js", REPO_ROOT);
const HARNESS_TOOLS_ENTRY = new URL("packages/harness/dist/plugins/tools/index.js", REPO_ROOT);
const ENV_FILE = new URL(".env", REPO_ROOT);

function loadEnvFile(path) {
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

/**
 * Harness 的内置模型插件当前只支持 OpenAI Chat Completions 协议。
 */
function readModelConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.MODEL;
  const baseUrl = process.env.OPENAI_BASE_URL;
  if (!apiKey || !model) {
    throw new Error("OPENAI_API_KEY 与 MODEL 必须在 .env 中配置");
  }
  if (!baseUrl) throw new Error("模型链路还需要 OPENAI_BASE_URL");
  return { apiKey, baseUrl, model };
}

function parseArgs(argv) {
  const options = {
    target: "harness",
    runs: 1,
    effort: "xhigh",
    variants: ["baseline"],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    contextWindow: Number(process.env.NOVA_TEST_CONTEXT_WINDOW ?? 32768),
    maxOutputTokens: 8192,
    debug: false,
    check: false,
    help: false,
  };
  const needValue = (flag, value) => {
    if (value === undefined) throw new Error(`${flag} 缺少值`);
    return value;
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === "-t" || flag === "--target") {
      const value = needValue(flag, argv[++index]);
      if (!TARGETS.includes(value)) throw new Error(`-t 取值非法: ${value}（允许 ${TARGETS.join(" | ")}）`);
      options.target = value;
    } else if (flag === "-n" || flag === "--runs") {
      const value = Number.parseInt(needValue(flag, argv[++index]), 10);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`-n 取值非法: ${argv[index]}`);
      options.runs = value;
    } else if (flag === "-e" || flag === "--effort") {
      const value = needValue(flag, argv[++index]);
      if (!EFFORTS.includes(value)) throw new Error(`-e 取值非法: ${value}（允许 ${EFFORTS.join(" | ")}）`);
      options.effort = value;
    } else if (flag === "--ab") {
      // A/B：同一条链路用 baseline / guided 两种 system prompt 各跑 -n 轮，末尾给对比。
      options.variants = VARIANT_NAMES;
    } else if (flag === "--variant") {
      const value = needValue(flag, argv[++index]);
      if (!VARIANT_NAMES.includes(value))
        throw new Error(`--variant 取值非法: ${value}（允许 ${VARIANT_NAMES.join(" | ")} | 或用 --ab）`);
      options.variants = [value];
    } else if (flag === "--timeout") {
      const value = Number.parseInt(needValue(flag, argv[++index]), 10);
      if (!Number.isSafeInteger(value) || value < 1000) throw new Error(`--timeout 至少 1000（毫秒）: ${argv[index]}`);
      options.timeoutMs = value;
    } else if (flag === "--max-output") {
      const value = Number.parseInt(needValue(flag, argv[++index]), 10);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--max-output 取值非法: ${argv[index]}`);
      options.maxOutputTokens = value;
    } else if (flag === "--context-window") {
      const value = Number.parseInt(needValue(flag, argv[++index]), 10);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`--context-window 取值非法: ${argv[index]}`);
      options.contextWindow = value;
    } else if (flag === "--debug") {
      options.debug = true;
    } else if (flag === "--check") {
      options.check = true;
    } else if (flag === "-h" || flag === "--help") {
      options.help = true;
    } else {
      throw new Error(`未知参数: ${flag}`);
    }
  }
  if (options.maxOutputTokens >= options.contextWindow) {
    throw new Error(`--max-output 必须小于 contextWindow(${options.contextWindow})`);
  }
  return options;
}

function helpText() {
  return [
    "用法: node example/candy-eval.mjs [-n RUNS] [-e EFFORT] [选项]",
    "",
    "选项:",
    "  -n, --runs N                轮数（默认 1，串行执行）",
    `  -e, --effort LEVEL          thinking 档位: ${EFFORTS.join(" | ")}（默认 xhigh）`,
    "      --ab                    同时跑 baseline 与 guided 两组 system prompt 并对比",
    `      --variant NAME          只跑单个变体: ${VARIANT_NAMES.join(" | ")}（默认 baseline）`,
    "      --timeout MS            单轮超时（默认 600000）",
    "      --max-output N          harness 链路的 maxOutputTokens（默认 8192）",
    "      --context-window N      harness 链路的 contextWindow（默认取 NOVA_TEST_CONTEXT_WINDOW 或 32768）",
    "      --debug                 打印每轮回答全文，便于核对判分",
    "      --check                 只加载依赖并校验 .env，不调用模型",
    "  -h, --help                  显示本帮助",
    "",
    "环境变量: NOVA_TEST_CONTEXT_WINDOW 覆盖 harness 链路的 contextWindow（默认 32768）。",
  ].join("\n");
}

/** Harness 链路：createAgentKernel + agent.send，模型适配由 Harness 插件持有。 */
async function askHarness(harness, config, options, system) {
  const kernel = await harness.core.createAgentKernel({
    maxConcurrentRuns: 1,
    defaultTimeoutMs: options.timeoutMs,
    configure: async (context) => {
      await context.plugin(
        harness.model.aiSdkModelPlugin({
          models: [
            {
              id: "candy",
              protocol: "openai-chat",
              baseURL: config.baseUrl,
              apiKey: config.apiKey,
              model: config.model,
              contextWindow: options.contextWindow,
              maxOutputTokens: options.maxOutputTokens,
            },
          ],
          defaultModel: "candy",
        }, {
          fetch: async (input, init) => {
            if (!init?.body || typeof init.body !== "string") return fetch(input, init);
            const body = JSON.parse(init.body);
            body.reasoning_effort = options.effort;
            return fetch(input, { ...init, body: JSON.stringify(body) });
          },
        }),
      );
      await context.plugin(harness.session.memorySessionPlugin());
      await context.plugin(harness.context.contextPlugin());
      await context.plugin(harness.tools.toolRuntimePlugin());
      await context.plugin(harness.loop.basicLoopPlugin());
    },
  });
  const started = performance.now();
  try {
    const agent = await kernel.createAgent({
      sessionId: `candy-${randomUUID()}`,
      systemPrompt: system,
      tools: [],
      allowedTools: [],
    });
    try {
      const result = await agent.send({ text: CANDY_PROMPT, timeoutMs: options.timeoutMs });
      if (result.kind !== "completed" || result.status !== "succeeded") {
        const code = result.error?.code ?? "-";
        const evidence = `正文 ${result.text.length} 字符，工具调用 ${result.toolCalls.length || "无"}`;
        throw new Error(`harness 运行 ${result.status}(${code}): ${result.error?.message ?? "无错误详情"}（${evidence}）`);
      }
      return {
        text: result.text,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        reasoningTokens: result.usage.reasoningTokens,
        seconds: (performance.now() - started) / 1000,
      };
    } finally {
      await agent.dispose();
    }
  } finally {
    await kernel.dispose();
  }
}

function formatTable(runs, total) {
  const headers = ["Run", "In Tok", "Out Tok", "Reason Tok", "Time(s)", "TPS", "OK", "Answer"];
  const rows = runs.map((run) => [
    String(run.run),
    String(run.inputTokens ?? "-"),
    String(run.outputTokens ?? "-"),
    run.error ? "!" : run.reasoningTokens === null ? "-" : String(run.reasoningTokens),
    run.seconds === undefined ? "-" : run.seconds.toFixed(1),
    run.seconds && run.outputTokens ? (run.outputTokens / run.seconds).toFixed(1) : "-",
    run.error ? "ERR" : run.correct ? "✓" : "✗",
    run.error ? preview(run.error, 48) : preview(run.text, 48),
  ]);
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column]))),
  );
  const line = (cells) =>
    cells
      .map((cell, column) => cell + " ".repeat(Math.max(0, widths[column] - displayWidth(cell))))
      .join("  ")
      .trimEnd();
  const graded = runs.filter((run) => !run.error).length;
  const correct = runs.filter((run) => run.correct).length;
  const accuracy = graded ? `  accuracy=${((correct / graded) * 100).toFixed(1)}%` : "";
  return [
    line(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(line),
    "",
    `Graded ${graded}/${total}  correct=${correct}${accuracy}`,
  ].join("\n");
}

/**
 * A/B 结论：按 target 对比 baseline 与 guided 的答对数，直接回答"引导是否修正了结论"。
 * 只统计成功返回的轮次；guided 全错或两组持平说明脚手架没起作用（更像预算被掐），
 * guided 明显抬升则说明原失败是疏忽、能被通用引导救回。
 */
function formatAbComparison(groups) {
  const targets = [...new Set(groups.map((group) => group.target))];
  const lines = ["A/B 对比（guided 相对 baseline 的答对变化）"];
  for (const target of targets) {
    const score = (variant) => {
      const runs = groups.find((group) => group.target === target && group.variant === variant)?.runs ?? [];
      const graded = runs.filter((run) => !run.error);
      return { hit: graded.filter((run) => run.correct).length, total: graded.length };
    };
    const base = score("baseline");
    const guided = score("guided");
    // 无成功样本时不下结论，避免把 OUTPUT_LIMIT / 超时误读成"引导无效"。
    if (!base.total && !guided.total) {
      lines.push(`  ${target}: 两组均无有效样本（链路或额度问题，A/B 不可判）`);
      continue;
    }
    const delta = (guided.total ? guided.hit / guided.total : 0) - (base.total ? base.hit / base.total : 0);
    const verdict = delta > 0 ? "↑ 引导修正了结论（原失败偏疏忽型）" : delta < 0 ? "↓ 引导反而变差" : "= 无变化";
    lines.push(`  ${target}: baseline ${base.hit}/${base.total}  →  guided ${guided.hit}/${guided.total}  ${verdict}`);
  }
  return lines.join("\n");
}

/** 失败原因完整输出、不截断；多行时统一缩进两格，便于和逐轮进度行区分。 */
function indent(text) {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

/** 中文回答按显示宽度截断，避免把表格撑歪。 */
function preview(text, limit) {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  if (displayWidth(flat) <= limit) return flat;
  let result = "";
  for (const char of flat) {
    if (displayWidth(result) + displayWidth(char) > limit - 3) break;
    result += char;
  }
  return `${result}...`;
}

/** CJK 字符和全角标点在终端占 2 列，其余 1 列。 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/u.test(char)
      ? 2
      : 1;
  }
  return width;
}

async function loadHarnessModules() {
  const entries = [
    ["core", HARNESS_ENTRY],
    ["model", HARNESS_MODEL_ENTRY],
    ["loop", HARNESS_LOOP_ENTRY],
    ["context", HARNESS_CONTEXT_ENTRY],
    ["session", HARNESS_SESSION_ENTRY],
    ["tools", HARNESS_TOOLS_ENTRY],
  ];
  const missing = entries.find(([, entry]) => !existsSync(fileURLToPath(entry)));
  if (missing) {
    throw new Error(`未找到 ${fileURLToPath(missing[1])}，先执行 pnpm --filter @nnova/harness build`);
  }
  const modules = await Promise.all(entries.map(async ([name, entry]) => [name, await import(entry.href)]));
  return Object.fromEntries(modules);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return 0;
  }
  // override：.env 优先于同名 shell 变量，保证脚本口径唯一。
  const envPath = fileURLToPath(ENV_FILE);
  if (!existsSync(envPath)) throw new Error(`未找到环境文件 ${envPath}（复制 .env 模板或配置密钥后重试）`);
  loadEnvFile(envPath);
  const targets = [options.target];
  const config = readModelConfig();
  const modules = await loadHarnessModules();
  console.log(`provider=openai  model=${config.model}  baseUrl=${config.baseUrl}`);
  console.log(`targets=${targets.join(",")}  runs=${options.runs}  timeout=${options.timeoutMs}ms`);
  if (options.check) {
    console.log("预检通过：依赖可加载，.env 配置齐全（未调用模型）。");
    return 0;
  }

  // baseline 单跑时标签仍是 [target]（保持原输出）；--ab 时才带上变体名。
  const ab = options.variants.length > 1;
  const groups = [];
  for (const target of targets)
    for (const variant of options.variants)
      groups.push({ target, variant, label: ab ? `${target}/${variant}` : target, runs: [] });

  let failed = 0;
  for (const group of groups) {
    for (let run = 1; run <= options.runs; run++) {
      const record = { run, variant: group.variant };
      try {
        const answer = await askHarness(modules, config, options, VARIANTS[group.variant]);
        Object.assign(record, answer, { correct: ANSWER_PATTERN.test(answer.text) });
        if (!record.text.trim()) throw new Error("模型未返回最终回答");
        if (!record.outputTokens) throw new Error("模型未返回 usage");
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
        record.correct = false;
        failed++;
      }
      group.runs.push(record);
      // 逐轮打印，串行评测时能立刻看到进度和某一轮卡住的位置。
      console.log(
        record.error
          ? `[${group.label}] Run ${run}  FAILED\n${indent(record.error)}`
          : `[${group.label}] Run ${run}  ${record.inputTokens} in / ${record.outputTokens} out / ` +
              `${record.reasoningTokens === null ? "-" : record.reasoningTokens} reason  ` +
              `${record.seconds.toFixed(1)}s  ` +
              `${record.outputTokens ? (record.outputTokens / record.seconds).toFixed(1) : "-"} tok/s  ` +
              `${record.correct ? "✓" : "✗"}`,
      );
      // 表格里的回答是截断预览；判分存疑时用 --debug 打出全文核对。
      if (options.debug && record.text)
        console.log(`--- [${group.label}] Run ${run} answer ---\n${record.text}\n--- end ---`);
    }
  }

  // 正确率只做统计不做硬判定：真实模型解题不稳定，失败体现在退出码上。
  for (const group of groups) {
    console.log(`\n[${group.label}]`);
    console.log(formatTable(group.runs, options.runs));
  }
  if (ab) console.log(`\n${formatAbComparison(groups)}`);
  const incomplete = groups
    .flatMap((group) => group.runs)
    .filter((run) => !run.error && (!run.text.trim() || !run.outputTokens));
  return failed || incomplete.length ? 1 : 0;
}

process.exitCode = await main().catch((error) => {
  console.error(`candy-eval: ${error instanceof Error ? error.message : String(error)}`);
  return 1;
});
