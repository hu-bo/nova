import { context, errorResult, text, type Tool, z } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const EXECUTION_OVERHEAD_MS = 5_000;

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "A single executable name or path — just the program, e.g. `pnpm`, `git`, `ls`, `sh`, `powershell.exe`. Do NOT put arguments, flags, or a complete shell command line here. INVALID examples: `\"pwd && ls -la\"`, `\"cd /app && pnpm test\"`, `\"ls -la | grep foo\"`, `\"cat foo.txt\"`. If you need shell syntax (`&&`, `|`, `>`, `;`, `$()`, variables, or `cd`), set command=`sh` (POSIX) or `powershell.exe` (Windows) and pass the script as the next array element.",
    ),
  args: z
    .array(z.string())
    .optional()
    .describe(
      "Arguments passed directly to the executable, one array item per argument — no shell parsing, no quoting tricks. For compound commands, use command `sh` with args [`-lc`, `<script>`] on POSIX, or `powershell.exe` with args [`-NoProfile`, `-Command`, `<script>`] on Windows.",
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory for the process. Prefer this over putting `cd` in a shell script — `cwd` is structured and works on every platform.",
    ),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647 - EXECUTION_OVERHEAD_MS)
    .optional()
    .describe(
      "Maximum execution time in milliseconds; defaults to 10000 (10 seconds) when omitted. For known long-running tasks such as builds, full test suites, or dependency installation, explicitly set a suitable longer timeout, e.g. 300000 (5 minutes).",
    ),
});

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "df",
  "du",
  "file",
  "find",
  "grep",
  "head",
  "hostname",
  "id",
  "ls",
  "pwd",
  "readlink",
  "realpath",
  "rg",
  "stat",
  "tail",
  "tree",
  "uname",
  "wc",
  "which",
  "whoami",
]);
const READ_ONLY_GIT_SUBCOMMANDS = new Set(["diff", "log", "ls-files", "ls-tree", "rev-parse", "show", "status"]);
const MUTATING_GIT_CONFIG_ARGUMENTS = new Set([
  "--add",
  "--delete",
  "--delete-all",
  "--replace-all",
  "--unset",
  "--unset-all",
]);
const MUTATING_FIND_ARGUMENTS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
  "-ok",
  "-okdir",
]);
// 仅识别单条 cd 和字面量路径；不解析或放行组合命令、重定向与 shell 展开。
const SIMPLE_CD_SCRIPT =
  /^[ \t]*cd(?:[ \t]+(?:--[ \t]+)?(?:[\p{L}\p{N}_./~:@%+=,-]+|'[^'\r\n]*'|"[^"$`\\\r\n]*"))?[ \t]*$/u;

function commandName(command: string): string {
  return command
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)!
    .replace(/\.exe$/i, "")
    .toLowerCase();
}

export function bashRisk(value: unknown): "read" | "exec" {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return "exec";
  const input = parsed.data;
  const command = commandName(input.command);
  if (
    command === "sh" &&
    input.args?.length === 2 &&
    (input.args[0] === "-c" || input.args[0] === "-lc") &&
    SIMPLE_CD_SCRIPT.test(input.args[1]!)
  )
    return "read";
  const args = input.args?.map((arg) => arg.toLowerCase()) ?? [];
  if (command === "find" && input.args?.some((arg) => MUTATING_FIND_ARGUMENTS.has(arg.toLowerCase()))) return "exec";
  if (command === "tree" && args.includes("-o")) return "exec";
  if (command === "rg" && args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))) return "exec";
  if (READ_ONLY_COMMANDS.has(command)) return "read";
  if (
    command === "git" &&
    ((READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? "") &&
      !args.some((arg) => arg === "--output" || arg.startsWith("--output="))) ||
      isReadOnlyGitConfig(args))
  )
    return "read";
  return "exec";
}

function isReadOnlyGitConfig(args: string[]): boolean {
  if (args[0] !== "config" || !args.includes("--list")) return false;
  return !args.some(
    (arg) =>
      MUTATING_GIT_CONFIG_ARGUMENTS.has(arg) ||
      arg.startsWith("--add=") ||
      arg.startsWith("--replace-all=") ||
      arg.startsWith("--unset=") ||
      arg.startsWith("--unset-all="),
  );
}

// Shell 解释器与带全局选项的 git：真实执行内容由后续参数决定，不能按名字记住放行。
const NEVER_REMEMBER_COMMANDS = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "powershell",
  "pwsh",
  "cmd",
  "command",
]);

/**
 * §6 `allow_always` 作用域：按「可执行程序 + 子命令」记忆，而不是按工具名。
 * 因此对 `bash` 点一次"总是允许" `git diff` 不会顺带放行 `git reset --hard`；
 * 解释器包装（`sh -lc "…"`）与 `git -C …` 这类首参是全局选项的调用返回 null，永不记住。
 */
export function bashApprovalScope(value: unknown): string | null {
  const parsed = schema.safeParse(value);
  if (!parsed.success) return null;
  const command = commandName(parsed.data.command);
  if (NEVER_REMEMBER_COMMANDS.has(command)) return null;
  const first = parsed.data.args?.[0]?.toLowerCase();
  if (first === undefined) return `bash:${command}`;
  return first.startsWith("-") ? null : `bash:${command}:${first}`;
}

export const bash: Tool<z.output<typeof schema>> = {
  name: "bash",
  description: [
    "Run ONE program directly. Despite the name `bash`, this tool does NOT start a shell — `command` is the program name only, never a shell command line.",
    "",
    "Calling convention:",
    "  command — a single executable name or path (e.g. `pnpm`, `git`, `ls`, `sh`, `powershell.exe`). Do not put arguments, flags, or a shell script here.",
    "  args    — one array item per argument; no shell parsing, no quoting tricks.",
    "  cwd     — working directory; prefer this over `cd` in a script.",
    "",
    "Correct:",
    "  ✅ {command: `pnpm`, args: [`tsc`, `--noEmit`], cwd: `/workspace/app`}",
    "  ✅ {command: `git`, args: [`diff`, `--stat`]}",
    "  ✅ {command: `ls`, args: [`-la`, `/workspace/app`]}",
    "",
    "Common mistakes (will fail):",
    "  ❌ {command: `pwd && ls -la`}          → split into two calls, or wrap in `sh`.",
    "  ❌ {command: `cd /app && pnpm test`}   → set `cwd` and call once, or wrap in `sh`.",
    "  ❌ {command: `ls -la | grep foo`}      → use the `grep` tool, or wrap in `sh`.",
    "",
    "Compound commands — only when you genuinely need shell syntax. Wrap the script yourself and pass it to `sh` or `powershell.exe`:",
    "  POSIX (macOS / Linux / WSL):",
    "    ✅ {command: `sh`, args: [`-lc`, `cd /workspace/app && pnpm test 2>&1 | head -50`]}",
    "  Windows:",
    "    ✅ {command: `powershell.exe`, args: [`-NoProfile`, `-Command`, `Get-ChildItem | Select-Object -First 5`]}",
    "",
    "Decision rule: if your command contains `&&`, `||`, `|`, `>`, `<`, `;`, `$(...)`, `` ` ` ``, variables, or `cd`, use `sh` (POSIX) or `powershell.exe` (Windows). Otherwise pass the program name in `command` and each argument as a separate element of `args`.",
  ].join("\n"),
  schema,
  risk: bashRisk,
  timeoutMs(value) {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data.timeoutMs ?? DEFAULT_TIMEOUT_MS) + EXECUTION_OVERHEAD_MS : undefined;
  },
  async execute(input, ctx) {
    const result = await context(ctx).exec(input.command, {
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const { value } = result;
    const content = [value.stdout, value.stderr].filter(Boolean).join("\n") || `(command exited ${value.exitCode})`;
    return { status: value.exitCode === 0 ? "ok" : "error", content: text(content), details: value };
  },
};
