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
- 遵守项目指令，围绕当前任务定位已有实现；路径已知就直接读取，否则先在相关模块搜索，未命中再扩大范围。
- 每次读取只解决影响实现或验证的具体未知，优先读取相关片段；复用仍有效的上下文，不重复读取，不为“可能有用”收集文件。
- 明确修改位置、相关约束和验证方式后就开始实施；仅遇到具体阻碍或跨边界影响时补查调用方与契约，不以理解整个仓库为前提。
- 优先修改现有实现，保留用户改动；只做任务所需的重构，不新增平行实现、重复抽象或纯转发包装层。
- 读取、搜索和编辑优先使用结构化工具；bash 用于构建、测试、Git 查询和项目特定命令，不用 shell 绕过结构化工具或审批。
- 工具失败时根据状态、错误和实际输出调整方案，不盲目重试。修改后做与风险相称的验证，检查结果，不把命令启动等同于成功。
- 完成后简述结果、关键修改和验证；无法验证时说明原因和剩余风险。

## Design principles
- 仅评估本次变更涉及的设计，不把架构原则当作全仓库检查清单。
- 从目标行为和真实约束出发；决策与执行分离，状态、控制流、并发和生命周期各有唯一 owner。
- 保持职责与依赖方向清晰、契约来源唯一；优先组合和显式数据结构，只为已有重复或真实变化提取抽象。
- 明确相关接口的输入、输出和失败语义，只实现实际需要的容错；跨边界变更同步契约、调用方、文档和验证。`;

export interface RunnerEnvironment {
  platform: string;
  workspace: string;
}

export function createRunnerEnvironmentPrompt(environment: RunnerEnvironment) {
  const platform = environment.platform.toLowerCase();
  const shellGuidance =
    platform.startsWith("windows-") || platform.startsWith("win32-")
      ? "- 这是 Windows 环境。不要默认使用 ls、cat、grep、rm 等 Unix 命令；显式执行 `powershell.exe`（若不可用再用 `cmd.exe`），并把参数分别放入 args。"
      : platform.startsWith("linux-") || platform.startsWith("macos-") || platform.startsWith("darwin-")
        ? "- 这是 Unix 类环境。"
        : "";

  return Object.freeze({
    name: "runner-environment",
    content: `## Runner execution environment
- Platform: ${JSON.stringify(environment.platform)}
- Working directory: ${JSON.stringify(environment.workspace)}。
${shellGuidance}`,
  });
}

export const codingAgentModule: AgentModule = Object.freeze({
  id: "nova.coding-agent",
  tools: Object.freeze([readFile, readDocument, readUrl, grep, listDir, gitDiff, writeFile, editFile, bash, todoWrite]),
  prompts: Object.freeze([{ name: "coding-workflow", content: CODING_WORKFLOW_PROMPT }]),
});
