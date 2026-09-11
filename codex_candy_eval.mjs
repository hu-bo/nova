#!/usr/bin/env node
/**
 * codex_candy_eval.mjs
 *
 * 用本地 codex CLI 测试糖果问题，统计 reasoning tokens 并判分。
 *   node codex_candy_eval.mjs -m gpt-5.5 -r high -n 5
 *
 * 与 codex_candy_eval.py 行为一对一对应：相同的 prompt、相同的命令行参数、
 * 相同的 JSON 事件解析、相同的表格格式、相同的判分正则、相同的错误处理。
 *
 * 实现要点：
 * - ESM、纯 stdlib，无外部依赖；最低 Node 18（用到了 \p{...} Unicode 属性正则、
 *   node:test 等）。
 * - codex 解析：Windows 上 `where codex`，POSIX 上 `which codex`，对应 Python 的
 *   `shutil.which("codex")`，避免裸名字在 .cmd 包装层下 CreateProcess 找不到。
 * - 多行题目通过 `spawnSync(..., { input })` 经 stdin 传入，绕开 codex.cmd 包装层
 *   吞换行的问题。
 * - JSON 事件流按行解析（item.completed/agent_message 拿最终文本，turn.completed/
 *   usage 拿 token 计数，error / turn.failed 收集错误）。
 * - 表格按显示宽度对齐：CJK 宽字符按 2 计、组合字符按 0 计。
 * - TTY 下用 "\x1b[<n>A" 上移光标做原地刷新（不用 CSI s/u，跨终端兼容性更好）。
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

export const CODEX_PROMPT = `不使用任何外部工具回答以下问题：

在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）

        苹果味  桃子味  西瓜味
圆形       7      9      8
五角星形   7      6      4
`;

// 正确答案 21：独立数字，前后非数字即视为命中。
export const ANSWER_PATTERN = /(?<!\d)21(?!\d)/;

export const ALLOWED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function parseArgs(argv) {
  const result = { model: undefined, effort: 'medium', tests: 1, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-m' || a === '--model') {
      const v = argv[++i];
      if (v === undefined) throw new Error('-m/--model 缺少值');
      result.model = v;
    } else if (a === '-r' || a === '--reasoning-effort') {
      const v = argv[++i];
      if (v === undefined) throw new Error('-r/--reasoning-effort 缺少值');
      if (!ALLOWED_EFFORTS.includes(v)) {
        throw new Error(`-r 取值非法: ${v}（允许: ${ALLOWED_EFFORTS.join(', ')}）`);
      }
      result.effort = v;
    } else if (a === '-n' || a === '--tests') {
      const v = argv[++i];
      if (v === undefined) throw new Error('-n/--tests 缺少值');
      const n = Number.parseInt(v, 10);
      if (!Number.isFinite(n) || n < 1) throw new Error(`-n 取值非法: ${v}`);
      result.tests = n;
    } else if (a === '-h' || a === '--help') {
      result.help = true;
    } else {
      throw new Error(`未知参数: ${a}`);
    }
  }
  return result;
}

export function makeHelp() {
  return [
    '用法: node codex_candy_eval.mjs [-m MODEL] [-r EFFORT] [-n TESTS]',
    '',
    '选项:',
    '  -m, --model NAME            Codex 模型名（如 gpt-5.5）；省略用本地默认',
    `  -r, --reasoning-effort LVL  取值: ${ALLOWED_EFFORTS.join(' | ')}（默认 medium）`,
    '  -n, --tests N               评测轮数（默认 1）',
    '  -h, --help                  显示本帮助',
  ].join('\n');
}

// 跨平台解析 codex 可执行路径。Windows 上 codex 多是 npm 安装的 codex.cmd 包装
// 脚本，裸名字 CreateProcess 找不到（PATHEXT 只补 .exe），用 `where` 解析出带
// 扩展名的完整路径再执行。
export function findCodex() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['codex'], { encoding: 'utf8' });
  if (r.status !== 0 || r.error) return null;
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first || null;
}

export function buildCodexArgs({ model, effort }) {
  const args = [
    'exec', '--json',
    '--skip-git-repo-check',
    '--ephemeral',
    '-s', 'read-only',
    // 关闭 codex 的跨会话记忆（~/.codex/memories），避免历史记忆注入提示词、
    // 污染评测结果。等价于 -c features.memories=false。
    '--disable', 'memories',
    '-c', `model_reasoning_effort=${effort}`,
  ];
  if (model) args.push('-m', model);
  return args;
}

export function parseCodexEvents(stdout) {
  let finalText = '';
  let usage = {};
  const errors = [];
  let turnFailed = false;
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'error' || event.type === 'turn.failed') {
      const e = event.error ?? event.message;
      const msg = e == null
        ? ''
        : typeof e === 'object'
          ? (e.message ?? JSON.stringify(e))
          : String(e);
      if (msg && !errors.includes(msg)) errors.push(msg);
      if (event.type === 'turn.failed') turnFailed = true;
    }
    if (event.type === 'item.completed') {
      const item = event.item ?? {};
      if (item.type === 'agent_message') finalText = item.text ?? finalText;
    } else if (event.type === 'turn.completed') {
      usage = event.usage ?? {};
    }
  }
  return { finalText, usage, errors, turnFailed };
}

export function runCodex({ model, effort, spawn = spawnSync }) {
  const exe = findCodex();
  if (!exe) {
    throw new Error('找不到 codex 可执行文件，请确认已安装并加入 PATH。');
  }
  const args = buildCodexArgs({ model, effort });

  // 多行题目通过 stdin 传入：作为命令行参数时，经 cmd.exe/codex.cmd 包装后换行
  // 会被吞掉，而管道里的内容能完整保留。
  const proc = spawn(exe, args, {
    input: CODEX_PROMPT,
    encoding: 'utf8',
    windowsHide: false,
  });

  const stdout = proc.stdout || '';
  const { finalText, usage, errors, turnFailed } = parseCodexEvents(stdout);

  if ((proc.status ?? 1) !== 0 || turnFailed || !finalText.trim()) {
    const details = [...errors];
    const stderr = (proc.stderr || '').trim();
    if (stderr) details.push('stderr:\n' + stderr);
    if (!errors && stdout.trim()) details.push('stdout:\n' + stdout.trim());
    const reason = details.join('\n\n') || 'Codex 未返回最终回答。';
    throw new Error(`codex exec failed (exit=${proc.status}):\n${reason}`);
  }

  return {
    finalText,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    reasoningTokens: usage.reasoning_output_tokens,
  };
}

// 终端显示宽度：组合字符 0，东亚宽字符/全角 2，其余 1。
export function charWidth(ch) {
  if (/\p{M}/u.test(ch)) return 0;
  if (/\p{East_Asian_Width=Wide}/u.test(ch)) return 2;
  if (/\p{East_Asian_Width=Fullwidth}/u.test(ch)) return 2;
  return 1;
}

export function displayWidth(text) {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

export function pad(text, width, align) {
  const gap = width - displayWidth(text);
  if (gap <= 0) return text;
  if (align === 'right') return ' '.repeat(gap) + text;
  if (align === 'center') {
    const left = Math.floor(gap / 2);
    return ' '.repeat(left) + text + ' '.repeat(gap - left);
  }
  return text + ' '.repeat(gap);
}

export function renderTable(headers, rows, aligns) {
  const cols = headers.length;
  const widths = Array.from({ length: cols }, (_, i) => displayWidth(headers[i]));
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const cell = row[i] == null ? '' : String(row[i]);
      const w = displayWidth(cell);
      if (w > widths[i]) widths[i] = w;
    }
  }
  const lines = [];
  lines.push(headers.map((h, i) => pad(h, widths[i], aligns[i])).join('  '));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of rows) {
    lines.push(row.map((cell, i) => pad(cell == null ? '' : String(cell), widths[i], aligns[i])).join('  '));
  }
  return lines.join('\n');
}

export function preview(text, max = 40) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return flat.slice(0, max) + '...';
}

// 探测是否可原地重绘。非 TTY 一律 false；Windows 上靠环境变量快速探测，匹配
// 原 Python 脚本“能 VT 就 VT”的行为。
export function supportsAnsi() {
  if (!process.stdout.isTTY) return false;
  if (process.platform === 'win32') {
    if (process.env.WT_SESSION) return true;
    if (process.env.ANSICON) return true;
    if (process.env.ConEmuANSI === 'ON') return true;
    return true;
  }
  return true;
}

export function setupConsole() {
  // Node 18+ 默认 UTF-8，无需显式 setEncoding。
  return supportsAnsi();
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  // 允许注入 spawn / now，方便测试。
  const { spawn = spawnSync, now = performance.now } = deps;

  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    console.error('');
    console.error(makeHelp());
    process.exit(2);
  }
  if (args.help) {
    console.log(makeHelp());
    return;
  }

  const useAnsi = setupConsole();
  const headers = ['Run', 'Codex', 'In Tok', 'Out Tok', 'Reason Tok', 'Time(s)', 'TPS', 'OK'];
  const aligns = ['right', 'left', 'right', 'right', 'right', 'right', 'right', 'center'];

  const runErrors = [];
  const rows = [];
  const graded = [];
  let prevLines = 0;

  for (let i = 1; i <= args.tests; i++) {
    let row;
    let ok;
    try {
      const start = now();
      const { finalText, inputTokens, outputTokens, reasoningTokens } =
        runCodex({ ...args, spawn });
      const elapsed = (now() - start) / 1000;
      const tps = outputTokens && elapsed > 0 ? outputTokens / elapsed : null;
      ok = ANSWER_PATTERN.test(finalText);
      row = [
        i,
        preview(finalText),
        inputTokens,
        outputTokens,
        reasoningTokens,
        elapsed.toFixed(1),
        tps != null ? tps.toFixed(1) : '-',
        ok ? '✓' : '✗',
      ];
    } catch (err) {
      runErrors.push(`Run ${i}: ${err.message}`);
      row = [i, `ERROR: ${preview(err.message)}`, '-', '-', '-', '-', '-', '-'];
    }
    rows.push(row);
    if (typeof ok === 'boolean') graded.push(ok);

    if (useAnsi) {
      // 用 CSI A（上移 n 行）+ CSI J（清屏）替代 CSI s/u，macOS Terminal.app
      // 不支持 s/u 会导致表头重复堆叠。
      if (prevLines > 0) process.stdout.write(`\x1b[${prevLines}A\x1b[J`);
      const table = renderTable(headers, rows, aligns);
      process.stdout.write(table + '\n');
      prevLines = table.split('\n').length;
    }
    if (runErrors.length) break;
  }

  if (!useAnsi) {
    console.log(renderTable(headers, rows, aligns));
  }

  const correct = graded.filter(Boolean).length;
  if (graded.length) {
    console.log(
      `\nGraded ${graded.length}/${args.tests}  correct=${correct}  ` +
      `accuracy=${((correct / graded.length) * 100).toFixed(1)}%`,
    );
  } else {
    console.log(`\nGraded 0/${args.tests}`);
  }

  if (runErrors.length) {
    console.error(`\n评测已中止，完整错误：\n${runErrors.join('\n\n')}`);
    process.exit(1);
  }
}

// 当作为脚本执行（而非被 import）时跑 main。被 import 时由测试驱动 main。
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
