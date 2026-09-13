#!/usr/bin/env node
/**
 * 糖果题评测脚本（从 packages/coding-agent/test/live-model.integration.test.ts 抽离）。
 *
 * 用法：
 *   node example/candy-eval.mjs                 两条链路各跑 1 轮
 *   node example/candy-eval.mjs -t dsh -n 5     只测 dsh-agent，串行 5 轮
 *   node example/candy-eval.mjs -t coding --ab  coding 链路 A/B：baseline vs 解题引导，看引导能否修正结论
 *   node example/candy-eval.mjs --check         只预检依赖与 .env，不发请求
 *
 * 同一道题分别走两条模型链路，对比 token 消耗、耗时与正确率：
 * - coding：@nova/model-adapters 的单轮 stream（coding-agent live 测试用的通路），不挂工具，
 *   -e 控制 thinking 档位，reasoning tokens 由 thinking 文本估算。
 * - dsh：@nnova/dsh-agent 的 kernel + agent.send，tools 为空，模型只能靠 reasoning 解题；
 *   该链路不暴露 thinking 文本，Reason Tok 记为 "-"。
 *
 * --ab 给每条链路再加一组"解题引导" system prompt（逐条复述约束 + 双向证明，不含答案），
 * 与 baseline 各跑 -n 轮并排对比，用来判断答错是"疏忽型"（能被通用引导救回）还是
 * "预算被掐型"（引导也救不动，通常是网关降智/额度问题）。
 *
 * 脚本不依赖 vitest：model-adapters 只导出 TS 源，这里用 node:module 的 resolve hook 把
 * `.js` 说明符重映射到同目录 `.ts`，再交给 Node 的 type stripping 执行（需 Node ≥ 22.18）。
 */

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
// 题面与判分口径的唯一来源，与 codex_candy_eval.mjs 共用，避免两边各自漂移。
import {
  ANSWER_PATTERN,
  CANDY_QUESTION as CANDY_PROMPT,
  NO_TOOL_INSTRUCTION as SYSTEM_PROMPT,
} from "./candy-prompt.mjs";

const DEFAULT_TIMEOUT_MS = 200_000;
const TARGETS = ["coding", "dsh"];
const PROVIDERS = ["anthropic", "openai"];
const EFFORTS = ["off", "low", "medium", "high", "max"];

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
const DSH_ENTRY = new URL("packages/dsh-agent/dist/index.js", REPO_ROOT);
const ADAPTERS_ENTRY = new URL("packages/model-adapters/src/index.ts", REPO_ROOT);
const ENV_FILE = new URL(".env", REPO_ROOT);

// TS 源内部按 Node ESM 惯例写 `./x.js`，而磁盘上只有 `x.ts`：这里补一次重映射，
// 让脚本能直接加载 @nova/model-adapters 的源码，不必引入 tsx / vitest。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
      const parent = context.parentURL;
      if (parent?.startsWith("file:")) {
        const candidate = new URL(`${specifier.slice(0, -3)}.ts`, parent);
        if (existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

/**
 * `.env` 里两组供应商配置各带一个 MODEL；评测按组切换，不假设哪一组可达。
 * openai 那组指向的网关在本机常被 WAF 拦截，因此默认走 anthropic（阿里云 MaaS 的 qwen）。
 */
function readModelConfig(provider) {
  const apiKey = provider === "anthropic" ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
  const model = (provider === "anthropic" ? process.env.ANTHROPIC_MODEL : undefined) ?? process.env.MODEL;
  const baseUrl = provider === "anthropic" ? process.env.ANTHROPIC_BASE_URL : process.env.OPENAI_BASE_URL;
  const wireApi = provider === "openai" ? process.env.MODEL_WIRE_API : undefined;
  if (!apiKey || !model) {
    throw new Error(`${provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"} 与 MODEL 必须在 .env 中配置`);
  }
  if (!baseUrl)
    throw new Error(`dsh-agent 链路还需要 ${provider === "anthropic" ? "ANTHROPIC_BASE_URL" : "OPENAI_BASE_URL"}`);
  return { provider, apiKey, baseUrl, model, wireApi };
}

function parseArgs(argv) {
  const options = {
    target: "both",
    runs: 1,
    provider: "openai",
    effort: "high",
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
      if (value !== "both" && !TARGETS.includes(value))
        throw new Error(`-t 取值非法: ${value}（允许 ${TARGETS.join(" | ")} | both）`);
      options.target = value;
    } else if (flag === "-n" || flag === "--runs") {
      const value = Number.parseInt(needValue(flag, argv[++index]), 10);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`-n 取值非法: ${argv[index]}`);
      options.runs = value;
    } else if (flag === "-p" || flag === "--provider") {
      const value = needValue(flag, argv[++index]);
      if (!PROVIDERS.includes(value)) throw new Error(`-p 取值非法: ${value}（允许 ${PROVIDERS.join(" | ")}）`);
      options.provider = value;
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
    "用法: node example/candy-eval.mjs [-t TARGET] [-n RUNS] [-p PROVIDER] [-e EFFORT] [选项]",
    "",
    "选项:",
    `  -t, --target TARGET         评测链路: ${TARGETS.join(" | ")} | both（默认 both）`,
    "  -n, --runs N                每条链路的轮数（默认 1，串行执行）",
    `  -p, --provider PROVIDER     取 .env 的哪组配置: ${PROVIDERS.join(" | ")}（默认 anthropic）`,
    `  -e, --effort LEVEL          两条链路的 thinking 档位: ${EFFORTS.join(" | ")}（默认 high）`,
    "      --ab                    对每条链路同时跑 baseline 与 guided 两组 system prompt 并对比",
    `      --variant NAME          只跑单个变体: ${VARIANT_NAMES.join(" | ")}（默认 baseline）`,
    "      --timeout MS            单轮超时（默认 200000）",
    "      --max-output N          dsh 链路的 maxOutputTokens（默认 8192）",
    "      --context-window N      dsh 链路的 contextWindow（默认取 NOVA_TEST_CONTEXT_WINDOW 或 32768）",
    "      --debug                 打印每轮回答全文，便于核对判分",
    "      --check                 只加载依赖并校验 .env，不调用模型",
    "  -h, --help                  显示本帮助",
    "",
    "环境变量: NOVA_TEST_CONTEXT_WINDOW 覆盖 dsh 链路的 contextWindow（默认 32768）。",
  ].join("\n");
}

/** coding 链路：model-adapters 单轮 stream，无工具，reasoning 由 thinking 文本估算。 */
async function askCoding(adapters, config, options, system) {
  const modelRef = {
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    ...(config.wireApi ? { wireApi: config.wireApi } : {}),
  };
  let text = "";
  let reasoning = "";
  let usage = { input: 0, output: 0 };
  let stopReason;
  const started = performance.now();
  try {
    for await (const event of adapters.createModel(modelRef).stream(
      {
        system,
        tools: [],
        thinking: options.effort,
        messages: [
          {
            id: "candy-eval",
            role: "user",
            createdAt: Date.now(),
            blocks: [{ type: "text", text: CANDY_PROMPT }],
          },
        ],
      },
      AbortSignal.timeout(options.timeoutMs),
    )) {
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
      throw new Error(`模型调用超时（${options.timeoutMs}ms）`);
    }
    throw error;
  }
  if (!stopReason) throw new Error("模型未返回 finish 事件");
  const seconds = (performance.now() - started) / 1000;
  return {
    text,
    inputTokens: usage.input,
    outputTokens: usage.output,
    reasoningTokens: reasoning ? adapters.estimateText(reasoning).tokens : 0,
    seconds,
  };
}

/** dsh 链路：kernel + agent.send；该链路不暴露 thinking 文本，reasoning 记为 null。 */
async function askDsh(dsh, config, options, system) {
  const kernel = await dsh.createDshAgentKernel({
    models: [
      {
        id: "candy",
        protocol: dshProtocol(config),
        baseURL: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        contextWindow: options.contextWindow,
        maxOutputTokens: options.maxOutputTokens,
        // 必须显式给档位：该网关默认开启思考且不限量，不传档位 dsh 就不会下发 thinking 参数，
        // 模型会把 maxOutputTokens 全部烧在思考上，正文 0 字符（OUTPUT_LIMIT）。
        reasoning: dshReasoning(options.effort),
      },
    ],
    defaultModel: "candy",
  });
  const started = performance.now();
  try {
    const agent = await kernel.createAgent({
      sessionId: `candy-${randomUUID()}`,
      systemPrompt: system,
      tools: [],
    });
    try {
      const result = await agent.send({ text: CANDY_PROMPT, timeoutMs: options.timeoutMs });
      if (result.status !== "succeeded") {
        // code 是关键区分：OUTPUT_LIMIT 说明被 maxOutputTokens 截断，MODEL_FAILED 说明请求本身失败。
        // 再带上现场：已产出多少正文、碰过哪些工具，才能判断是啰嗦还是在反复重试工具调用。
        const code = result.error?.code ?? "-";
        const evidence =
          `正文 ${result.text.length} 字符` +
          `，工具调用 ${result.toolCalls.map((call) => call.toolName).join(",") || "无"}`;
        throw new Error(
          `dsh-agent 运行 ${result.status}(${code}): ${result.error?.message ?? "无错误详情"}（${evidence}）`,
        );
      }
      return {
        text: result.text,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
        reasoningTokens: null,
        seconds: (performance.now() - started) / 1000,
      };
    } finally {
      await agent.dispose();
    }
  } finally {
    await kernel.dispose();
  }
}

/** dsh-agent 的 protocol 是供应商 + wire API 的组合，openai 组要看 MODEL_WIRE_API。 */
function dshProtocol(config) {
  if (config.provider === "anthropic") return "anthropic";
  return config.wireApi === "responses" ? "openai-responses" : "openai-chat";
}

/** dsh-agent 只认四档推理档位，coding 链路的 max 归并到 high。 */
function dshReasoning(effort) {
  return effort === "max" ? "high" : effort;
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

async function loadCodingModule() {
  try {
    return await import(ADAPTERS_ENTRY.href);
  } catch (error) {
    throw new Error(
      `加载 @nova/model-adapters 源码失败（需 Node ≥ 22.18 的 type stripping，` +
        `旧版本请用 node --experimental-strip-types 执行）: ${error.message}`,
    );
  }
}

async function loadDshModule() {
  if (!existsSync(fileURLToPath(DSH_ENTRY))) {
    throw new Error(`未找到 ${fileURLToPath(DSH_ENTRY)}，先执行 pnpm --filter @nnova/dsh-agent build`);
  }
  return import(DSH_ENTRY.href);
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
  loadDotenv({ path: envPath, override: true, quiet: true });
  const targets = options.target === "both" ? TARGETS : [options.target];
  const config = readModelConfig(options.provider);
  const modules = {
    coding: targets.includes("coding") ? await loadCodingModule() : undefined,
    dsh: targets.includes("dsh") ? await loadDshModule() : undefined,
  };
  console.log(`provider=${options.provider}  model=${config.model}  baseUrl=${config.baseUrl}`);
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
        const answer =
          group.target === "coding"
            ? await askCoding(modules.coding, config, options, VARIANTS[group.variant])
            : await askDsh(modules.dsh, config, options, VARIANTS[group.variant]);
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
