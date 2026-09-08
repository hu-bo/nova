import { context, errorResult, text, type Tool, z } from "./shared.js";
const schema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().optional(),
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
    "Run an executable in the workspace. Pass its arguments separately in args; command is not shell-parsed.",
  schema,
  risk: bashRisk,
  async execute(input, ctx) {
    const result = await context(ctx).exec(input.command, {
      args: input.args,
      cwd: input.cwd,
      timeoutMs: input.timeoutMs,
    });
    if (!result.ok) return errorResult(result.error, `${result.error.code}: ${result.error.message}`);
    const { value } = result;
    const content = [value.stdout, value.stderr].filter(Boolean).join("\n") || `(command exited ${value.exitCode})`;
    return { status: value.exitCode === 0 ? "ok" : "error", content: text(content), details: value };
  },
};
