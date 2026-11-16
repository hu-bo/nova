import { CHAT_AGENT_PROFILE, type Configuration, type SubmitInput } from "@nova/agent-ui-contracts";
import { chatProfile } from "@nova/coding-harness";
import { DomainError } from "../../shared/domain-error.js";
import { resolveSkill, type AcceptedSkill } from "../skills/index.js";

export interface AcceptedExecution {
  agentProfile?: { id: "chat"; version: string; systemPrompt: string };
  skill?: AcceptedSkill;
}
export function validateAgentProfile(configuration: Configuration, mode: "chat" | "project", hasGoal: boolean) {
  const profile = configuration.agentProfile;
  if (!profile) return;
  if (profile.version !== CHAT_AGENT_PROFILE.version || configuration.backendId !== "nova")
    throw new DomainError("VALIDATION_ERROR", "Agent profile version is unavailable");
  if (mode !== "chat" || configuration.remoteConnectionId || configuration.mode !== "plan" || hasGoal)
    throw new DomainError("CONFLICT", "Chat agents require a text chat with read-only permissions and no Goal");
}
export function acceptExecution(configuration: Configuration, input: SubmitInput): AcceptedExecution {
  if (input.skill && !configuration.agentProfile)
    throw new DomainError("CONFLICT", "This skill requires a non-coding chat agent");
  if (!configuration.agentProfile) return {};
  if (input.mode === "steer" || input.blocks.some((block) => block.type !== "text"))
    throw new DomainError("CONFLICT", "Chat agents accept text in ordinary inputs only");
  return {
    agentProfile: {
      ...configuration.agentProfile,
      systemPrompt:
        chatProfile.systemPrompt +
        "\n\nThis is a text conversation. Deliver analysis, rewritten text and questions directly in messages. " +
        "No external tools or persistent candidate profiles are available. Read-only permissions do not restrict rewriting text. " +
        "Complete each response and wait for the user's next input.",
    },
    ...(input.skill ? { skill: resolveSkill(input.skill) } : {}),
  };
}
