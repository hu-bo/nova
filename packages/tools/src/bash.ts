import { context, errorResult, text, type Tool, z } from "./shared.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const EXECUTION_OVERHEAD_MS = 5_000;

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe(
      "A single executable name or path, such as `pnpm`, `git`, `sh`, or `powershell.exe`. Do not put arguments or a complete shell command here.",
    ),
  args: z
    .array(z.string())
    .optional()
    .describe(
      "Arguments passed directly to the executable, one array item per argument. For shell syntax, use command `sh` with args [`-lc`, `<script>`], or `powershell.exe` with args [`-NoProfile`, `-Command`, `<script>`].",
    ),
  cwd: z
    .string()
    .optional()
    .describe("Working directory for the process. Prefer this over putting `cd` in a shell script."),
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
    READ_ONLY_GIT_SUBCOMMANDS.has(args[0] ?? "") &&
    !args.some((arg) => arg === "--output" || arg.startsWith("--output="))
  )
    return "read";
  return "exec";
}

export const bash: Tool<z.output<typeof schema>> = {
  name: "bash",
  description:
    "Run one executable directly in the workspace; despite the tool name, no shell is started automatically. `command` must be only the executable name or path, with normal arguments in `args` and the working directory in `cwd`. Example: {command: `pnpm`, args: [`tsc`, `--noEmit`], cwd: `/workspace/app`}. If the operation needs shell syntax such as `cd`, `&&`, `|`, `>`, variables, or quoting, explicitly run a shell: {command: `sh`, args: [`-lc`, `cd /workspace/app && pnpm tsc --noEmit 2>&1 | head -50`]}. On Windows use `powershell.exe` with `-NoProfile`, `-Command`, and the script as separate args. Never put a complete command line directly in `command`.",
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
