import { configurationSchema, type Configuration } from "@nova/agent-ui-contracts";
import { bindingSchema } from "../projects/index.js";
import type { ProjectBindingService } from "../projects/index.js";
import { DomainError } from "../../shared/domain-error.js";
import type { ConversationReader } from "../conversations/index.js";
import type { RunnerReader } from "../runners/index.js";
import { createRemoteTools } from "@nova/tools/harness";
import type { SkillEnvironment } from "./skill.service.js";
import type { SkillCatalogQuery } from "./skill-catalog.js";

/**
 * 查询参数 → 执行环境解析（§8.2 GET /skills 行：会话按原绑定、项目按当前绑定、
 * 纯设备按全局层解析，校验多参数一致性；服务端裁决，不信任 URL 组合）。
 */

export type EnvironmentDeps = {
  conversations: Pick<ConversationReader, "readEnvironment">;
  bindings: Pick<ProjectBindingService, "get">;
  runnerReader: Pick<RunnerReader, "readWorkspace">;
  storageConfigured: boolean;
  /** 无工具 chat 环境不提供工作区工具集；由持续配置判断（红线 1：只收紧宿主能力）。 */
};

/** 宿主在工作区环境提供的工具名（requiredTools 校验的宿主能力面，§4.1 只收紧不扩权）。 */
const HOST_ALL_TOOLS = createRemoteTools({
  createContext: async () => {
    throw new Error("tool-name registry must not execute tools");
  },
}).map((tool) => tool.name);
/** Plan 只读：不提供写入/执行命令工具。 */
const HOST_READ_TOOLS = new Set(["list_dir", "read_file", "grep", "git_diff"]);
const HOST_ALL_TOOL_SET = new Set(HOST_ALL_TOOLS);

/** requiredTools 只能引用宿主在该模式下实际提供的工具（P0-F5 双端校验的服务端侧）。 */
export function hostToolNames(mode: "plan" | "build" | "auto", hasWorkspace: boolean): Set<string> {
  if (!hasWorkspace) return new Set();
  if (mode === "plan") return new Set(HOST_READ_TOOLS);
  return new Set(HOST_ALL_TOOL_SET);
}

/** 兼容既有导出名（全量工具面）。 */
export const HOST_WORKSPACE_TOOL_NAMES: ReadonlySet<string> = HOST_ALL_TOOL_SET;

export async function resolveSkillEnvironment(
  deps: EnvironmentDeps,
  ownerUserId: string,
  query: SkillCatalogQuery & {
    conversationId?: string | undefined;
    projectId?: string | undefined;
    runnerId?: string | undefined;
  },
): Promise<SkillEnvironment> {
  const base: SkillEnvironment = {
    mode: "build",
    hasWorkspace: false,
    hostToolNames: new Set(),
    storageConfigured: deps.storageConfigured,
    specSession: false,
    projectId: null,
    ownerUserId,
    runnerRowId: null,
    workspaceId: null,
    relativeCwd: null,
  };
  if (query.conversationId) {
    const conversation = await deps.conversations.readEnvironment({ conversationId: query.conversationId, ownerUserId });
    if (!conversation) throw new DomainError("NOT_FOUND", "Conversation is unavailable");
    const configuration = conversation.configuration ?? configurationSchema.parse({});
    const binding = conversation.binding ? bindingSchema.parse(conversation.binding) : null;
    if (query.projectId && query.projectId !== conversation.projectId)
      throw new DomainError("VALIDATION_ERROR", "Skill directory parameters do not match the conversation");
    if (query.runnerId && query.runnerId !== (binding?.runnerId ?? null))
      throw new DomainError("VALIDATION_ERROR", "Skill directory parameters do not match the conversation");
    return withConfiguration(base, configuration, {
      projectId: conversation.projectId,
      specSession: Boolean(conversation.specId),
      bindingRunnerId: binding?.runnerId ?? null,
      workspaceId: binding?.workspaceId ?? null,
      canonicalCwd: binding?.canonicalCwd ?? null,
    });
  }
  if (query.projectId) {
    const binding = await deps.bindings.get(query.projectId, ownerUserId);
    if (query.runnerId && query.runnerId !== (binding?.runnerId ?? null))
      throw new DomainError("VALIDATION_ERROR", "Skill directory parameters do not match the project binding");
    const hasWorkspace = Boolean(binding?.runnerId);
    return {
      ...base,
      hasWorkspace,
      hostToolNames: hostToolNames("build", hasWorkspace),
      projectId: query.projectId,
      runnerRowId: binding?.runnerId ?? null,
      workspaceId: binding?.workspaceId ?? null,
      relativeCwd: binding?.canonicalCwd ?? null,
    };
  }
  if (query.runnerId) {
    const runner = await deps.runnerReader.readWorkspace({ id: query.runnerId, ownerUserId });
    if (!runner) throw new DomainError("NOT_FOUND", "Runner is unavailable");
    // 纯设备查询只看全局层；项目层需要 workspace/目录绑定，由会话或项目参数决定。
    return { ...base, runnerRowId: query.runnerId };
  }
  return base;
}

function withConfiguration(
  base: SkillEnvironment,
  configuration: Configuration,
  context: {
    projectId: string | null;
    specSession: boolean;
    bindingRunnerId: string | null;
    workspaceId: string | null;
    canonicalCwd: string | null;
  },
): SkillEnvironment {
  const isChat = Boolean(configuration.agentProfile);
  const hasWorkspace = !isChat && Boolean(context.bindingRunnerId || context.workspaceId);
  return {
    ...base,
    mode: configuration.mode ?? "build",
    hasWorkspace,
    hostToolNames: hostToolNames(configuration.mode ?? "build", hasWorkspace),
    specSession: context.specSession,
    projectId: context.projectId,
    runnerRowId: context.bindingRunnerId,
    workspaceId: context.workspaceId,
    relativeCwd: context.canonicalCwd,
  };
}
