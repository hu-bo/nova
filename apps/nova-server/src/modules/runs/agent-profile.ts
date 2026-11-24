import { CHAT_AGENT_PROFILE, type Configuration, type SubmitInput } from "@nova/agent-ui-contracts";
import { chatProfile } from "@nova/coding-harness";
import { DomainError } from "../../shared/domain-error.js";
import type { AcceptedAgentProfile } from "../skills/index.js";
import type { AcceptedSkill } from "../skills/index.js";

/**
 * 已接受执行快照（§6、P0-F2）：技能与 Agent 内容在此固定；
 * 恢复使用同一版本与正文，禁止重读「最新版本」或当前磁盘文件（红线 4）。
 * 旧 checkpoint 行中 agentProfile 为 chat 形状、skill 为旧 AcceptedSkill 形状；
 * 新增字段均为可选派生，读取方按缺省兼容。
 */
export interface AcceptedExecution {
  agentProfile?:
    | { id: "chat"; version: string; systemPrompt: string }
    | AcceptedAgentProfile;
  skill?: AcceptedSkill;
}

export type PinnedExecution = { skill?: AcceptedSkill; agent?: AcceptedAgentProfile };

export function validateAgentProfile(configuration: Configuration, mode: "chat" | "project", hasGoal: boolean) {
  const profile = configuration.agentProfile;
  if (!profile) return;
  if (configuration.backendId !== "nova") throw new DomainError("VALIDATION_ERROR", "Agent profile version is unavailable");
  if ("id" in profile) {
    if (profile.version !== CHAT_AGENT_PROFILE.version)
      throw new DomainError("VALIDATION_ERROR", "Agent profile version is unavailable");
    if (mode !== "chat" || configuration.remoteConnectionId || configuration.mode !== "plan" || hasGoal)
      throw new DomainError("CONFLICT", "Chat agents require a text chat with read-only permissions and no Goal");
    return;
  }
  // 本地 Agent 配置首期作为可选主 Agent profile：文本会话边界与 chat 相同，但模式选择留给用户。
  if (mode !== "chat" || configuration.remoteConnectionId || hasGoal)
    throw new DomainError("CONFLICT", "Local agents require a text chat with no Goal");
}

/**
 * 固定执行快照。技能与 Agent 内容由 skills 模块在入队前解析（pin），
 * 本函数只做一致性约束并写入快照，不再次读取「最新」内容。
 */
export function acceptExecution(configuration: Configuration, input: SubmitInput, pinned: PinnedExecution = {}): AcceptedExecution {
  const profile = configuration.agentProfile;
  const execution: AcceptedExecution = {};
  if (profile) {
    if (input.mode === "steer" || input.blocks.some((block) => block.type !== "text"))
      throw new DomainError("CONFLICT", "Chat agents accept text in ordinary inputs only");
    if ("id" in profile) {
      execution.agentProfile = {
        ...profile,
        systemPrompt:
          chatProfile.systemPrompt +
          "\n\nThis is a text conversation. Deliver analysis, rewritten text and questions directly in messages. " +
          "No external tools or persistent candidate profiles are available. Read-only permissions do not restrict rewriting text. " +
          "Complete each response and wait for the user's next input.",
      };
    } else {
      if (!pinned.agent) throw new DomainError("VALIDATION_ERROR", "Agent profile reference is unavailable");
      execution.agentProfile = pinned.agent;
    }
  }
  if (input.skill) {
    // 快照缺少已固定技能说明入队前解析缺失；运行期不得回退重读磁盘或最新版本。
    if (!pinned.skill) throw new DomainError("VALIDATION_ERROR", "Skill reference is unavailable");
    execution.skill = pinned.skill;
  }
  return execution;
}
