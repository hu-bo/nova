import type { AgentModule } from "@nova/harness";
import { bash, editFile, gitDiff, grep, listDir, readFile, readUrl, todoWrite, writeFile } from "@nova/tools";

const CODING_WORKFLOW_PROMPT = `## Coding workflow
- 先读取相关文件、调用链和项目指令，确认已有能力与职责边界后再修改；不要凭目录名猜实现。
- 优先修改现有实现，保持变更局部且与目标一致；不要创建平行 V2、兼容包装层或做无关重构，并保留用户已有改动。
- 读取、搜索和编辑优先使用结构化工具；bash 用于构建、测试、Git 查询和项目特定命令，不用 shell 绕过结构化工具或审批。
- 工具失败时依据明确的 status、typed error、exitCode 和实际输出调整方案，不盲目重试，也不把命令启动等同于验证成功。
- 修改后执行与风险相称的测试、类型检查或构建，检查真实结果；无法验证时说明原因和剩余风险。
- 完成时确认目标行为已实现，且没有 dead code、重复抽象、pass-through wrapper 或陈旧兼容路径；最终回答先给结果，再说明关键修改和验证。`;

export const codingAgentModule: AgentModule = Object.freeze({
  id: "nova.coding-agent",
  tools: Object.freeze([readFile, readUrl, grep, listDir, gitDiff, writeFile, editFile, bash, todoWrite]),
  prompts: Object.freeze([{ name: "coding-workflow", content: CODING_WORKFLOW_PROMPT }]),
});
