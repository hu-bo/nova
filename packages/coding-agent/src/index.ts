import type { AgentModule } from "@nova/harness";
import {
  bash,
  editFile,
  gitDiff,
  grep,
  listDir,
  readDocument,
  readFile,
  readUrl,
  todoWrite,
  writeFile,
} from "@nova/tools";

const CODING_WORKFLOW_PROMPT = `## Coding workflow
- 先读取相关文件、调用链和项目指令，确认已有能力与职责边界后再修改；不要凭目录名猜实现。
- 优先修改现有实现，保持变更局部且与目标一致；不要创建平行 V2、兼容包装层或做无关重构，并保留用户已有改动。
- 读取、搜索和编辑优先使用结构化工具；bash 用于构建、测试、Git 查询和项目特定命令，不用 shell 绕过结构化工具或审批。
- PDF、Office 文档和 CSV 必须使用 read_document；read_file 只用于 UTF-8 文本与源码。
- 工具失败时依据明确的 status、typed error、exitCode 和实际输出调整方案，不盲目重试，也不把命令启动等同于验证成功。
- 修改后执行与风险相称的测试、类型检查或构建，检查真实结果；无法验证时说明原因和剩余风险。
- 完成时确认目标行为已实现，且没有 dead code、重复抽象、pass-through wrapper 或陈旧兼容路径；最终回答先给结果，再说明关键修改和验证。

## General architecture thinking
- Design from user outcomes, system constraints, key state transitions, and end-to-end data flow—not from languages, frameworks, directory structures, or design patterns. First determine whether the problem belongs to a local implementation, a module boundary, or a system interaction.
- Assign a single owner to each business decision, state, control flow, concurrency boundary, and lifecycle. Separate decisions from execution and sources of truth from derived views; avoid multiple components writing the same state or maintaining duplicate truths.
- Draw boundaries around cohesive responsibilities and real directions of change. Keep the stable core dependent on explicit contracts and place volatile transport, persistence, provider, and presentation details at the edges; do not add layers that only forward parameters.
- Make interfaces explicit about inputs, outputs, invariants, errors, defaults, versions, and ownership. Transform data only at clear boundaries, and keep one canonical source for each protocol, schema, and shared type.
- Extract abstractions only from repetition or variation that already exists, can be named precisely, and hides details irrelevant to callers. Prefer a direct implementation when an abstraction adds concepts, boolean switches, hidden control flow, or navigation across many directories.
- Treat failure paths as part of the architecture. Give timeouts, cancellation, retries, idempotency, partial failures, resource cleanup, backpressure, and observability clear owners, and implement only the resilience the system actually needs.
- Evaluate the real constraints on security, performance, reliability, maintainability, cost, and consistency, and explain tradeoffs with evidence. Do not introduce complexity solely in the name of best practices, technology trends, or hypothetical future needs.
- Design evolution paths to be compatible, migratable, reversible, and removable. For changes across boundaries, update contracts, consumers, documentation, and verification together; avoid permanent dual writes, dual reads, or long-lived old and new implementations.`;

export interface RunnerEnvironment {
  platform: string;
  workspace: string;
}

export function createRunnerEnvironmentPrompt(environment: RunnerEnvironment) {
  const platform = environment.platform.toLowerCase();
  const shellGuidance =
    platform.startsWith("windows-") || platform.startsWith("win32-")
      ? "- 这是 Windows 环境。不要默认使用 ls、cat、grep、rm 等 Unix 命令；需要管道、重定向或 shell 内建命令时，显式执行 `powershell.exe`（若不可用再用 `cmd.exe`），并把参数分别放入 args。"
      : platform.startsWith("linux-") || platform.startsWith("macos-") || platform.startsWith("darwin-")
        ? "- 这是 Unix 类环境。需要管道、重定向或其他 shell 语法时，显式执行 `sh`，并通过 args 传入 `-lc` 和脚本。"
        : "- 不要假定它是 Linux；先用已有结构化工具或轻量命令确认可用能力，再选择平台兼容的可执行程序。";

  return Object.freeze({
    name: "runner-environment",
    content: `## Runner execution environment
- Platform: ${JSON.stringify(environment.platform)}
- Working directory: ${JSON.stringify(environment.workspace)}
- 选择与该平台兼容的可执行程序和路径格式。
- \`bash\` 工具虽然沿用这个名称，但它直接启动 command，不经过 shell 解析；command 只能放可执行程序名，参数必须逐项放入 args。
${shellGuidance}`,
  });
}

export const codingAgentModule: AgentModule = Object.freeze({
  id: "nova.coding-agent",
  tools: Object.freeze([readFile, readDocument, readUrl, grep, listDir, gitDiff, writeFile, editFile, bash, todoWrite]),
  prompts: Object.freeze([{ name: "coding-workflow", content: CODING_WORKFLOW_PROMPT }]),
});
