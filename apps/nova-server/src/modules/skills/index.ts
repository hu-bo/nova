import type { FastifyInstance } from "fastify";
import { productSkillSchema, type ProductSkill } from "@nova/agent-ui-contracts";
import type { RunnerLocalResources } from "../runners/index.js";
import type { SkillRepository } from "./skill.repository.js";
import { SkillService } from "./skill.service.js";
import { skillRoutes } from "./skill.routes.js";
import type { SkillDirectoryPort } from "./skill-directory.js";
import type { EnvironmentDeps } from "./skill-environment.js";

/**
 * Skills 模块公开边界（跨模块引用一律走本文件）。
 * - skillView：AcceptedSkill → 展示 DTO；供消息投影（run.repository）使用。
 * - resolveSkill：已废弃的内存实现改为登记表读取；执行快照在入队时由
 *   SkillService.pinForQueueing 固定（§6），runs 不再自行解析选择。
 */

/** 旧 checkpoint 的 execution.skill 形状无新字段；skillView 只依赖展示字段（P0-F2 兼容）。 */
export function skillView(skill: import("./skill.service.js").AcceptedSkill): ProductSkill {
  return productSkillSchema.parse({
    id: skill.id,
    version: skill.version,
    name: skill.name,
    description: skill.description,
    source: skill.source,
  });
}

declare module "fastify" {
  interface FastifyInstance {
    localResources: RunnerLocalResources;
    skillService: SkillService;
  }
}

export type SkillsModuleDeps = {
  service: SkillService;
  repository: SkillRepository;
  directory: SkillDirectoryPort;
  /** 跨模块查询依赖由 app 组装注入（避免模块间静态环）。 */
  environment: EnvironmentDeps;
};

export async function skillsModule(app: FastifyInstance, deps: SkillsModuleDeps): Promise<void> {
  await skillRoutes(app, {
    service: deps.service,
    catalog: { repository: deps.repository, directory: deps.directory },
    environment: deps.environment,
  });
}

export { SkillService, DEFAULT_REQUIREMENTS, isLocalSource, localEntryKey, normalizeRelativeDir, skillIssueMessage } from "./skill.service.js";
export { createSkillRepository } from "./skill.repository.js";
export type { AcceptedSkill, SkillEnvironment, AcceptedCatalogEntry, AgentProfileReference } from "./skill.service.js";
export type { AcceptedAgentCatalog, AcceptedAgentProfile, ParsedAgentDefinition } from "./agent-definition.js";
export type { SkillCatalogDiagnostic, SkillCatalogStatus } from "@nova/agent-ui-contracts";
export type {
  LocalCatalogEntry,
  LocalCatalogView,
  SkillDirectoryPort,
} from "./skill-directory.js";
export { evaluateSkillApplicability, parseSkillMarkdown, skillVersionSha256 } from "./skill-definition.js";
export { toRuntimeSkillId } from "./skill-runtime-id.js";
