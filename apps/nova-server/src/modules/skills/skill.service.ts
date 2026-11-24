import {
  type AgentCatalogEntry,
  type Configuration,
  type SkillApplicability,
  type SkillCatalogDiagnostic,
  type SkillCatalogEntry,
  type SkillExecutionRequirements,
  type SkillSelection,
  type SkillSource,
  type SkillUnavailability,
  type SkillVersionDetail,
} from "@nova/agent-ui-contracts";
import { careerCoachSkill, specSkill, skillsCreaterSkill } from "@nova/tools/harness";
import { DomainError } from "../../shared/domain-error.js";
import {
  evaluateSkillApplicability,
  normalizeSkillText,
  parseSkillMarkdown,
  skillApplicabilityMessage,
  SKILL_CONTEXT_BUDGET_CHARACTERS,
  skillVersionSha256,
  type SkillParseIssue,
} from "./skill-definition.js";
import {
  agentRefId,
  agentVersionFromSha,
  parseAgentMarkdown,
  type AcceptedAgentCatalog,
  type AcceptedAgentProfile,
} from "./agent-definition.js";
import { toRuntimeSkillId } from "./skill-runtime-id.js";
import type { LocalCatalogEntry, LocalCatalogView, SkillDirectoryPort } from "./skill-directory.js";
import { hostToolNames } from "./skill-environment.js";
import type { SkillRepository } from "./skill.repository.js";
import type { SkillRow } from "../../../database/schema/skill.table.js";
import type { SkillVersionRow } from "../../../database/schema/skill-version.table.js";
import type { UserModelProfilesService } from "../model-config/index.js";

/**
 * Skills 模块服务（docs/nova-skills.md §4–§6、§8.2）。
 * 平台草稿/版本管理（C2）、内置登记（C3）、本地快照接受（E2/E3）、Agent 接入（E4）
 * 与入队准入（F1/F5）共用本文件的解析与校验规则，避免「同一事实多个来源」。
 * 目录合并构建见 skill-catalog.ts。
 */

/** 固定到执行快照的技能。旧 checkpoint 只含 id/version/content/description/name/source；新字段可选以保持恢复兼容（P0-F2）。 */
export interface AcceptedSkill {
  /** 选择/目录 ID：内置为 `nova.*`，用户技能为数据库 UUID。 */
  id: string;
  version: string;
  content: string;
  description: string;
  name: string;
  source: SkillSource;
  /** Harness 运行时 ID（`nova.*` / `skill.<uuid>`）。 */
  runtimeId?: string;
  /** skill_versions.id */
  versionId?: string;
  slug?: string;
  requirements?: SkillExecutionRequirements;
  /** 版本内容摘要（规范化正文+执行配置+资源清单）。 */
  sha256?: string;
  /** 本地快照对应的磁盘入口摘要；漂移判定用（§4.3）。 */
  sourceSha256?: string | null;
}

/** 目录/入队解析所需的执行环境；由会话或页面参数决定，服务端裁决（不信任 URL 组合）。 */
export type SkillEnvironment = {
  mode: "plan" | "build" | "auto";
  hasWorkspace: boolean;
  hostToolNames: ReadonlySet<string>;
  storageConfigured: boolean;
  /** Spec 专用会话会额外注入 nova.spec，参与 40,000 字符预算。 */
  specSession: boolean;
  projectId: string | null;
  ownerUserId: string;
  /** 本地来源定位：注册 runners 行 ID、工作区与相对目录（根为 "."）。 */
  runnerRowId: string | null;
  workspaceId: string | null;
  relativeCwd: string | null;
};

/** 客户端提交的 Agent 配置引用（有来源和版本；内容由服务端解析）。 */
export type AgentProfileReference = { source: "runner-global" | "runner-project"; refId: string; version: string };

export const DEFAULT_REQUIREMENTS: SkillExecutionRequirements = {
  allowedModes: ["plan", "build", "auto"],
  requiredTools: [],
  requiresWorkspace: false,
  requiresPublishing: false,
};

/** 规范化相对目录标识："."、""、"./" 与首尾斜杠变体等价（与 Runner 侧 normalize_relative_dir 对齐）。 */
export function normalizeRelativeDir(dir: string | null | undefined): string {
  if (!dir) return ".";
  const trimmed = dir.replaceAll("\\", "/").replace(/^\.\/?/, "").replace(/^\/+|\/+$/g, "");
  if (trimmed === "" || trimmed === ".") return ".";
  return trimmed;
}

export function localEntryKey(entry: Pick<LocalCatalogEntry, "scope" | "workspaceId" | "relativeDir" | "name">): string {
  return [
    entry.scope,
    entry.scope === "project" ? entry.workspaceId : "",
    entry.scope === "project" ? normalizeRelativeDir(entry.relativeDir) : "",
    entry.name,
  ].join("|");
}

export function isLocalSource(source: SkillSource): source is "runner-global" | "runner-project" {
  return source === "runner-global" || source === "runner-project";
}

/** 内置登记来源；场景内置 nova.spec 不进目录（由服务端按 Spec 会话注入，§3 第 4 段）。 */
export const SCENARIO_BUILTIN_RUNTIME_IDS: ReadonlySet<string> = new Set([specSkill.id]);

type BuiltinRegistration = {
  runtimeId: string;
  version: string;
  displayName: string;
  description: string;
  content: string;
  requirements: SkillExecutionRequirements;
};

function builtinRegistrations(): BuiltinRegistration[] {
  return [
    {
      runtimeId: careerCoachSkill.id,
      version: careerCoachSkill.version,
      displayName: "求职教练",
      description: careerCoachSkill.description ?? "",
      content: careerCoachSkill.content,
      requirements: DEFAULT_REQUIREMENTS,
    },
    {
      runtimeId: specSkill.id,
      version: specSkill.version,
      displayName: "规格驱动",
      description: specSkill.description ?? "",
      content: specSkill.content,
      requirements: DEFAULT_REQUIREMENTS,
    },
    {
      runtimeId: skillsCreaterSkill.id,
      version: skillsCreaterSkill.version,
      displayName: "技能创建助手",
      description: skillsCreaterSkill.description ?? "",
      content: skillsCreaterSkill.content,
      requirements: DEFAULT_REQUIREMENTS,
    },
  ];
}

export type VersionSummary = {
  id: string;
  version: string;
  slug: string;
  description: string;
  displayName: string | null;
  requirements: SkillExecutionRequirements;
  sha256: string;
  createdAt: string;
};

export type PlatformSkillView = {
  id: string;
  slug: string;
  displayName: string | null;
  description: string;
  source: SkillSource;
  projectId: string | null;
  draftRevision: number;
  disabled: boolean;
  currentPublished: VersionSummary | null;
  draft: { body: string; requirements: SkillExecutionRequirements; revision: number } | null;
};

export type AcceptedCatalogEntry =
  | { status: "ready"; version: string; versionId: string }
  | { status: "invalid"; issues: string[] }
  | { status: "failed"; issues: string[] };

export class SkillService {
  constructor(
    private readonly repository: SkillRepository,
    private readonly directory: SkillDirectoryPort,
    private readonly host: { storageConfigured: boolean },
    private readonly models?: Pick<UserModelProfilesService, "validateSelection">,
  ) {}

  /** 由会话持续配置与原绑定构造执行环境（入队准入与目录共用同一推导，P0-F1/F5）。 */
  conversationEnvironment(input: {
    ownerUserId: string;
    specSession: boolean;
    projectId: string | null;
    configuration: Configuration;
    binding: { runnerId: string | null; workspaceId: string | null; canonicalCwd: string | null } | null;
  }): SkillEnvironment {
    const isChat = Boolean(input.configuration.agentProfile);
    const hasWorkspace = !isChat && Boolean(input.binding?.runnerId);
    const mode = input.configuration.mode ?? "build";
    return {
      mode,
      hasWorkspace,
      hostToolNames: hostToolNames(mode, hasWorkspace),
      storageConfigured: this.host.storageConfigured,
      specSession: input.specSession,
      projectId: input.projectId,
      ownerUserId: input.ownerUserId,
      runnerRowId: input.binding?.runnerId ?? null,
      workspaceId: input.binding?.workspaceId ?? null,
      relativeCwd: input.binding?.canonicalCwd ?? null,
    };
  }

  // ---------- P0-C3 内置登记 ----------

  /**
   * 部署/启动登记：按 ID、版本、内容摘要写入 skills/skill_versions（source=builtin）。
   * 同版本不同摘要拒绝（启动报错，登记账本不可被静默改写）；同版本同摘要幂等跳过。
   */
  async registerBuiltins(): Promise<void> {
    for (const registration of builtinRegistrations()) {
      const slug = registration.runtimeId.slice("nova.".length);
      const body = normalizeSkillText(registration.content);
      const sha256 = skillVersionSha256({ body, requirements: registration.requirements }, null);
      let row = await this.repository.findBuiltinBySlug(slug);
      if (!row) {
        try {
          row = await this.repository.insertBuiltinSkill({
            slug,
            displayName: registration.displayName,
            description: registration.description,
          });
        } catch {
          // 并发启动时唯一索引兜底：冲突后重查既有行。
          row = await this.repository.findBuiltinBySlug(slug);
          if (!row) throw new Error(`Builtin skill registration failed: ${registration.runtimeId}`);
        }
      }
      const existing = await this.repository.findVersion(row.id, registration.version);
      if (existing) {
        if (existing.sha256 !== sha256)
          throw new Error(
            `Builtin skill ${registration.runtimeId}@${registration.version} digest conflicts with the registered immutable version`,
          );
        if (row.currentPublishedVersionId !== existing.id)
          await this.repository.setCurrentPublishedVersion(row.id, existing.id);
        continue;
      }
      const created = await this.repository.insertVersion({
        skillId: row.id,
        version: registration.version,
        body,
        slug,
        description: registration.description,
        displayName: registration.displayName,
        requirements: registration.requirements,
        sha256,
        sourceSha256: null,
        resources: null,
      });
      if (created.sha256 !== sha256)
        throw new Error(`Builtin skill ${registration.runtimeId}@${registration.version} registration raced with a conflicting digest`);
      await this.repository.setCurrentPublishedVersion(row.id, created.id);
    }
  }

  // ---------- P0-C2 平台草稿与版本 ----------

  /** 校验正文并派生展示元数据；显式配置与正文 `nova` 同时出现时必须一致（§4.1）。 */
  private parsePlatformBody(body: string, explicit?: SkillExecutionRequirements) {
    const parsed = parseSkillMarkdown(body);
    if (!parsed.ok) throw new DomainError("VALIDATION_ERROR", skillIssueMessage(parsed.issues), { issues: parsed.issues });
    if (explicit !== undefined && !sameRequirements(explicit, parsed.definition.requirements))
      throw new DomainError("VALIDATION_ERROR", "Explicit execution requirements conflict with the 'nova' field in the body");
    return parsed.definition;
  }

  async createPlatform(
    ownerUserId: string,
    input: { projectId?: string | null | undefined; body: string; requirements?: SkillExecutionRequirements | undefined },
  ) {
    const definition = this.parsePlatformBody(input.body, input.requirements);
    const row = await this.repository.insertPlatformSkill({
      ownerUserId,
      projectId: input.projectId ?? null,
      slug: definition.slug,
      displayName: null,
      description: definition.description,
      draftBody: definition.body,
      draftRequirements: definition.requirements,
    });
    return this.detailView(row);
  }

  async getPlatform(ownerUserId: string, skillId: string) {
    const row = await this.requireVisibleRow(ownerUserId, skillId);
    return this.detailView(row);
  }

  async updateDraft(
    ownerUserId: string,
    skillId: string,
    input: { expectedRevision: number; body: string; requirements?: SkillExecutionRequirements | undefined },
  ) {
    await this.requireOwnedPlatformRow(ownerUserId, skillId);
    const definition = this.parsePlatformBody(input.body, input.requirements);
    const updated = await this.repository.updateDraft(skillId, ownerUserId, input.expectedRevision, {
      draftBody: definition.body,
      slug: definition.slug,
      description: definition.description,
      requirements: definition.requirements,
    });
    if (!updated) throw new DomainError("CONFLICT", "Draft changed concurrently; re-read the skill before saving");
    return this.detailView(updated);
  }

  /**
   * 发布不可变版本：内容固定为当前草稿（名称/说明/配置单来源），expectedRevision 防并发；
   * 相同版本同内容幂等返回原版本，内容不同 409（§8.2）。
   */
  async publish(ownerUserId: string, skillId: string, input: { expectedRevision: number; version: string }) {
    const row = await this.requireOwnedPlatformRow(ownerUserId, skillId);
    if (row.disabled) throw new DomainError("CONFLICT", "Skill is disabled");
    if (row.draftRevision !== input.expectedRevision)
      throw new DomainError("CONFLICT", "Draft changed concurrently; re-read before publishing");
    if (row.draftBody === null) throw new DomainError("VALIDATION_ERROR", "Skill draft is empty");
    const definition = this.parsePlatformBody(row.draftBody, row.draftRequirements ?? undefined);
    const sha256 = skillVersionSha256(definition, null);
    const existing = await this.repository.findVersion(skillId, input.version);
    if (existing) {
      if (existing.sha256 !== sha256)
        throw new DomainError("CONFLICT", "Version already published with different content");
      if (row.currentPublishedVersionId !== existing.id) await this.repository.setCurrentPublishedVersion(skillId, existing.id);
      return versionSummary(existing);
    }
    const created = await this.repository.insertVersion({
      skillId,
      version: input.version,
      body: definition.body,
      slug: definition.slug,
      description: definition.description,
      displayName: row.displayName,
      requirements: definition.requirements,
      sha256,
      sourceSha256: null,
      resources: null,
    });
    if (created.sha256 !== sha256)
      throw new DomainError("CONFLICT", "Version already published with different content");
    await this.repository.setCurrentPublishedVersion(skillId, created.id);
    return versionSummary(created);
  }

  async listVersions(ownerUserId: string, skillId: string, filters: { limit: number; cursor?: string }) {
    const row = await this.requireVisibleRow(ownerUserId, skillId);
    const cursor = filters.cursor ? new Date(filters.cursor) : undefined;
    if (filters.cursor && (!cursor || Number.isNaN(cursor.getTime())))
      throw new DomainError("VALIDATION_ERROR", "Invalid cursor");
    const rows = await this.repository.listVersions(row.id, { limit: filters.limit, ...(cursor ? { cursor } : {}) });
    const page = rows.slice(0, filters.limit);
    return {
      items: page.map(versionSummary),
      nextCursor: rows.length > filters.limit && page.length > 0 ? page.at(-1)!.createdAt.toISOString() : null,
    };
  }

  /** 版本详情：平台/内置/本地均读版本行（本地行由快照接受时写入，正文事实源仍是磁盘）。 */
  async getVersionDetail(ownerUserId: string, skillId: string, version: string): Promise<SkillVersionDetail> {
    const row = await this.requireVisibleRow(ownerUserId, skillId);
    const versionRow = await this.repository.findVersion(row.id, version);
    if (!versionRow) throw new DomainError("NOT_FOUND", "Skill version is unavailable");
    const applicability = this.catalogApplicability(row, versionRow, ownerUserId);
    return {
      ...catalogEntryFromVersion(row, versionRow, applicability),
      body: versionRow.body,
      resources: versionRow.resources ?? [],
      diagnostics: isLocalSource(row.source) ? this.localDiagnostics(row, ownerUserId) : [],
    };
  }

  async disable(ownerUserId: string, skillId: string) {
    const row = await this.requireOwnedPlatformRow(ownerUserId, skillId);
    const updated = await this.repository.disableSkill(row.id, ownerUserId);
    return this.detailView(updated ?? row);
  }

  // ---------- P0-E1/E2/E3 本地目录快照接受 ----------

  /**
   * 目录发布接收（在已认证 Runner session 下由 runners 模块调用）：
   * 技能条目 upsert 来源索引行并按磁盘摘要映射/复用 `0.0.<revision>` 快照版本；
   * Agent 条目解析后返回给连接态视图持有（§8.1）。
   */
  async accept(input: {
    ownerUserId: string;
    runnerRowId: string;
    entries: readonly LocalCatalogEntry[];
    readSnapshot: (entry: LocalCatalogEntry) => Promise<string>;
  }): Promise<{ skills: Map<string, AcceptedCatalogEntry>; agents: AcceptedAgentCatalog[] }> {
    return { skills: await this.acceptSkills(input), agents: await this.acceptAgents(input) };
  }

  private async acceptSkills(input: {
    ownerUserId: string;
    runnerRowId: string;
    entries: readonly LocalCatalogEntry[];
    readSnapshot: (entry: LocalCatalogEntry) => Promise<string>;
  }): Promise<Map<string, AcceptedCatalogEntry>> {
    const result = new Map<string, AcceptedCatalogEntry>();
    for (const entry of input.entries) {
      if (entry.kind !== "skill") continue;
      const key = localEntryKey(entry);
      const source: "runner-global" | "runner-project" = entry.scope === "global" ? "runner-global" : "runner-project";
      const row = await this.repository.insertLocalIdentity({
        ownerUserId: input.ownerUserId,
        runnerId: input.runnerRowId,
        source,
        workspaceId: entry.scope === "project" ? entry.workspaceId : null,
        relativeCwd: entry.scope === "project" ? normalizeRelativeDir(entry.relativeDir) : null,
        slug: entry.name,
        description: entry.description,
      });
      const existing = await this.repository.findVersionBySourceSha(row.id, entry.sha256);
      if (existing) {
        result.set(key, { status: "ready", version: existing.version, versionId: existing.id });
        continue;
      }
      let body: string;
      try {
        body = await input.readSnapshot(entry);
      } catch (error) {
        // 快照失败如实按条目记录；不影响其它条目，也不以空结果冒充成功。
        result.set(key, { status: "failed", issues: [error instanceof Error ? error.message : String(error)] });
        continue;
      }
      const parsed = parseSkillMarkdown(body);
      if (!parsed.ok) {
        result.set(key, { status: "invalid", issues: parsed.issues.map((issue) => `${issue.code}: ${issue.message}`) });
        continue;
      }
      const sha256 = skillVersionSha256(parsed.definition, null);
      const reusable = await this.repository.findVersionBySha(row.id, sha256);
      if (reusable) {
        result.set(key, { status: "ready", version: reusable.version, versionId: reusable.id });
        continue;
      }
      result.set(key, await this.insertLocalVersion(row, entry, parsed.definition, sha256));
    }
    return result;
  }

  private async insertLocalVersion(
    row: SkillRow,
    entry: LocalCatalogEntry,
    definition: { slug: string; description: string; requirements: SkillExecutionRequirements; body: string },
    sha256: string,
  ): Promise<AcceptedCatalogEntry> {
    // 版本行不可覆盖；0.0.<revision> 冲突时按最新计数重试（并发目录更新下摘要相同会命中既有行）。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const revision = (await this.repository.countVersions(row.id)) + 1;
      const version = `0.0.${revision}`;
      const inserted = await this.repository.insertVersion({
        skillId: row.id,
        version,
        body: definition.body,
        slug: definition.slug,
        description: definition.description,
        displayName: row.displayName,
        requirements: definition.requirements,
        sha256,
        sourceSha256: entry.sha256,
        resources: null,
      });
      if (inserted.sha256 === sha256) return { status: "ready", version: inserted.version, versionId: inserted.id };
      if (inserted.version !== version) return { status: "failed", issues: ["version slot allocation failed after concurrent catalog updates"] };
    }
    return { status: "failed", issues: ["version slot allocation failed after concurrent catalog updates"] };
  }

  // ---------- P0-E4 Agent 配置接入 ----------

  private async acceptAgents(input: {
    ownerUserId: string;
    runnerRowId: string;
    entries: readonly LocalCatalogEntry[];
    readSnapshot: (entry: LocalCatalogEntry) => Promise<string>;
  }): Promise<AcceptedAgentCatalog[]> {
    const accepted: AcceptedAgentCatalog[] = [];
    for (const entry of input.entries) {
      if (entry.kind !== "agent") continue;
      const source: "runner-global" | "runner-project" = entry.scope === "global" ? "runner-global" : "runner-project";
      const refId = agentRefId({
        ownerUserId: input.ownerUserId,
        runnerRowId: input.runnerRowId,
        scope: entry.scope,
        workspaceId: entry.scope === "project" ? entry.workspaceId : "",
        relativeDir: entry.scope === "project" ? normalizeRelativeDir(entry.relativeDir) : "",
        name: entry.name,
      });
      const base = {
        refId,
        version: agentVersionFromSha(entry.sha256),
        source,
        runnerRowId: input.runnerRowId,
        workspaceId: entry.scope === "project" ? entry.workspaceId : null,
        relativeCwd: entry.scope === "project" ? normalizeRelativeDir(entry.relativeDir) : null,
        name: entry.name,
        description: entry.description,
        sha256: entry.sha256,
      };
      try {
        const body = await input.readSnapshot(entry);
        const parsed = parseAgentMarkdown(body, `${entry.name}.md`);
        accepted.push(
          parsed.ok
            ? { ...base, definition: parsed.definition, incompatibilities: [] }
            : { ...base, definition: null, incompatibilities: parsed.issues },
        );
      } catch (error) {
        accepted.push({
          ...base,
          definition: null,
          incompatibilities: [{ code: "invalid_frontmatter", message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    return accepted;
  }

  /**
   * Agent 引用固定（入队前）：按 (refId, version) 命中当前目录视图并校验归属层；
   * 可选 modelId 必须在用户已有模型配置中可用；恢复使用快照正文，不重读磁盘（红线 4）。
   */
  async pinAgent(profile: AgentProfileReference, environment: SkillEnvironment): Promise<AcceptedAgentProfile> {
    if (!environment.runnerRowId)
      throw new DomainError("CONFLICT", "Local agents require a Runner-bound environment", { reason: "RUNNER_BINDING_REQUIRED" });
    const view = this.directory.view(environment.runnerRowId, environment.ownerUserId);
    if (!view) throw new DomainError("NOT_FOUND", "Agent is unavailable");
    if (view.status === "unsupported") throw new DomainError("CONFLICT", "Runner does not support local resource discovery");
    if (view.status === "offline") throw new DomainError("CONFLICT", "Runner is offline", { reason: "RUNNER_OFFLINE" });
    if (view.status === "stale" || view.status === "incomplete" || view.status === "scanning")
      throw new DomainError("CONFLICT", "Local directory is not verified; refresh and re-select the agent");
    const item = view.agents.find((agent) => agent.refId === profile.refId && agent.version === profile.version);
    if (!item || item.source !== profile.source) throw new DomainError("NOT_FOUND", "Agent is unavailable");
    if (item.source === "runner-project") {
      if (
        item.workspaceId !== environment.workspaceId ||
        normalizeRelativeDir(item.relativeCwd) !== normalizeRelativeDir(environment.relativeCwd)
      )
        throw new DomainError("CONFLICT", "Agent belongs to a different project directory");
    }
    if (!item.definition)
      throw new DomainError(
        "CONFLICT",
        item.incompatibilities.map((issue) => issue.message).join("；") || "Agent is incompatible",
      );
    if (item.definition.modelId && this.models)
      await this.models.validateSelection(item.definition.modelId, environment.ownerUserId, null);
    return {
      source: item.source,
      refId: item.refId,
      version: item.version,
      name: item.definition.name,
      description: item.definition.description,
      systemPrompt: item.definition.body,
      ...(item.definition.modelId ? { modelId: item.definition.modelId } : {}),
      ...(item.definition.disallowTools.length > 0 ? { disallowTools: item.definition.disallowTools } : {}),
    };
  }

  /** 目录可见 Agent 列表（GET /agents）：兼容性逐条标注；技能引用仅作为预选建议派生为名称。 */
  listAgents(input: {
    ownerUserId: string;
    runnerRowId: string | null;
    workspaceId: string | null;
    relativeCwd: string | null;
  }): AgentCatalogEntry[] {
    if (!input.runnerRowId) return [];
    const view = this.directory.view(input.runnerRowId, input.ownerUserId);
    if (!view) return [];
    return view.agents
      .filter((item) => {
        if (item.source === "runner-global") return true;
        return (
          item.workspaceId === input.workspaceId &&
          normalizeRelativeDir(item.relativeCwd) === normalizeRelativeDir(input.relativeCwd)
        );
      })
      .map((item) => ({
        refId: item.refId,
        name: item.name,
        description: item.description,
        source: item.source,
        version: item.version,
        ...(item.definition && item.definition.skillRefs.length > 0 ? { suggestedSkill: item.definition.skillRefs[0]! } : {}),
        ...(item.definition?.modelId !== undefined ? { modelId: item.definition.modelId } : {}),
        incompatibilities: item.definition
          ? []
          : item.incompatibilities.map((issue) => ({ code: "catalog_incomplete" as const, message: issue.message })),
        runnerId: item.runnerRowId,
        workspaceId: item.workspaceId,
        cwd: item.relativeCwd,
        sha256: item.sha256,
      }));
  }

  // ---------- P0-F1/F5 入队准入与版本固定 ----------

  /**
   * 入队前解析选择：所有权、项目范围、版本可用性、停用、模式/工具/工作区/存储、
   * 本地目录漂移与注入预算；失败抛 DomainError，原因结构化返回（校验集中在本模块）。
   */
  async pinForQueueing(selection: SkillSelection, environment: SkillEnvironment): Promise<AcceptedSkill> {
    const { row, version } = await this.resolveSelection(environment.ownerUserId, selection);
    const applicability = this.admissionApplicability(row, version, environment);
    if (applicability.status !== "available")
      throw new DomainError("CONFLICT", skillApplicabilityMessage(applicability) || "Skill is not selectable", {
        reasons: applicability.reasons,
      });
    return acceptedFromVersion(row, version);
  }

  /** 选择 ID → 技能与版本行。内置经 `nova.*` 确切 ID，用户技能经数据库 UUID；不可见一律 NOT_FOUND。 */
  async resolveSelection(ownerUserId: string, selection: SkillSelection) {
    if (selection.id.startsWith("nova.")) {
      const row = await this.repository.findBuiltinBySlug(selection.id.slice("nova.".length));
      if (!row) throw new DomainError("NOT_FOUND", "Skill is unavailable");
      const version = await this.repository.findVersion(row.id, selection.version);
      if (!version) throw new DomainError("NOT_FOUND", "Skill version is unavailable");
      return { row, version };
    }
    const row = await this.repository.findRowById(selection.id);
    if (!row) throw new DomainError("NOT_FOUND", "Skill is unavailable");
    if (row.source !== "builtin" && row.ownerUserId !== ownerUserId)
      throw new DomainError("NOT_FOUND", "Skill is unavailable");
    const version = await this.repository.findVersion(row.id, selection.version);
    if (!version) throw new DomainError("NOT_FOUND", "Skill version is unavailable");
    return { row, version };
  }

  /** 版本可用性已在 resolveSelection 校验；这里覆盖停用、项目范围、执行要求、目录漂移与预算。 */
  admissionApplicability(row: SkillRow, version: SkillVersionRow, environment: SkillEnvironment): SkillApplicability {
    const reasons: SkillUnavailability[] = [];
    if (row.disabled) reasons.push({ code: "disabled", message: "技能已停用，不能新选择" });
    if (row.source === "platform" && row.projectId && row.projectId !== environment.projectId)
      reasons.push({ code: "out_of_scope", message: "技能绑定了其它项目，当前会话不可用" });
    if (isLocalSource(row.source) && row.runnerId)
      reasons.push(...localDirectoryReasons(this.directory.view(row.runnerId, environment.ownerUserId), row.slug, version.sourceSha256));
    reasons.push(...evaluateSkillApplicability(version.requirements ?? DEFAULT_REQUIREMENTS, environment).reasons);
    const injected = version.body.length + (environment.specSession ? specSkill.content.length : 0);
    if (injected > SKILL_CONTEXT_BUDGET_CHARACTERS)
      reasons.push({
        code: "budget_exceeded",
        message: `技能正文与场景内置技能合计 ${injected} 字符，超出 ${SKILL_CONTEXT_BUDGET_CHARACTERS} 上下文预算`,
      });
    return { status: reasons.length === 0 ? "available" : "unavailable", reasons };
  }

  /** 目录展示用适用性（无运行环境上下文：只看停用与静态可恢复状态）。 */
  private catalogApplicability(row: SkillRow, version: SkillVersionRow, ownerUserId: string): SkillApplicability {
    const reasons: SkillUnavailability[] = [];
    if (row.disabled) reasons.push({ code: "disabled", message: "技能已停用，不能新选择" });
    if (isLocalSource(row.source) && row.runnerId)
      reasons.push(...localDirectoryReasons(this.directory.view(row.runnerId, ownerUserId), row.slug, version.sourceSha256));
    return { status: reasons.length === 0 ? "available" : "unavailable", reasons };
  }

  // ---------- 视图 ----------

  async detailView(row: SkillRow): Promise<PlatformSkillView> {
    const published = row.currentPublishedVersionId
      ? await this.repository.findVersionById(row.currentPublishedVersionId)
      : undefined;
    return {
      id: row.id,
      slug: row.slug,
      displayName: row.displayName,
      description: row.description,
      source: row.source,
      projectId: row.projectId,
      draftRevision: row.draftRevision,
      disabled: row.disabled,
      currentPublished: published ? versionSummary(published) : null,
      draft:
        row.draftBody === null
          ? null
          : { body: row.draftBody, requirements: row.draftRequirements ?? DEFAULT_REQUIREMENTS, revision: row.draftRevision },
    };
  }

  private async requireVisibleRow(ownerUserId: string, skillId: string): Promise<SkillRow> {
    const row = await this.repository.findRowById(skillId);
    if (!row) throw new DomainError("NOT_FOUND", "Skill is unavailable");
    if (row.source !== "builtin" && row.ownerUserId !== ownerUserId)
      throw new DomainError("NOT_FOUND", "Skill is unavailable");
    return row;
  }

  private async requireOwnedPlatformRow(ownerUserId: string, skillId: string): Promise<SkillRow> {
    const row = await this.repository.findOwnedRow(skillId, ownerUserId);
    if (!row || row.source !== "platform") throw new DomainError("NOT_FOUND", "Skill is unavailable");
    return row;
  }

  private localDiagnostics(row: SkillRow, ownerUserId: string): SkillCatalogDiagnostic[] {
    if (!row.runnerId) return [{ code: "scan_error", message: "本地技能缺少来源 Runner", name: row.slug }];
    const view = this.directory.view(row.runnerId, ownerUserId);
    if (!view)
      return [{ code: "scan_error", message: "本地目录不可用：Runner 未连接或未声明发现能力", name: row.slug }];
    if (!view.entries.some((entry) => entry.kind === "skill" && entry.name === row.slug))
      return [{ code: "scan_error", message: "磁盘源文件已被移除或重命名", name: row.slug }];
    return [];
  }
}

export function catalogEntryFromVersion(row: SkillRow, version: SkillVersionRow, applicability: SkillApplicability): SkillCatalogEntry {
  return {
    id: row.source === "builtin" ? `nova.${row.slug}` : row.id,
    version: version.version,
    name: version.displayName ?? row.displayName ?? version.slug,
    description: version.description,
    source: row.source,
    requirements: version.requirements ?? DEFAULT_REQUIREMENTS,
    projectId: row.projectId,
    runnerId: row.runnerId,
    workspaceId: row.workspaceId,
    cwd: row.relativeCwd,
    sha256: version.sha256,
    applicability,
    disabled: row.disabled,
  };
}

function acceptedFromVersion(row: SkillRow, version: SkillVersionRow): AcceptedSkill {
  return {
    id: row.source === "builtin" ? `nova.${row.slug}` : row.id,
    runtimeId: toRuntimeSkillId(row.source, row.source === "builtin" ? row.slug : row.id),
    version: version.version,
    versionId: version.id,
    source: row.source,
    slug: version.slug,
    name: version.displayName ?? row.displayName ?? version.slug,
    description: version.description,
    content: version.body,
    requirements: version.requirements ?? DEFAULT_REQUIREMENTS,
    sha256: version.sha256,
    sourceSha256: version.sourceSha256,
  };
}

/** 本地目录状态 → 不适用原因（§4.3：断连/过期/不完整/漂移都不能冒充成功，也不谎报未安装）。 */
function localDirectoryReasons(
  view: LocalCatalogView | undefined,
  slug: string,
  sourceSha256: string | null,
): SkillUnavailability[] {
  if (!view) return [{ code: "runner_offline", message: "本地技能需要其 Runner 在线并同步目录后才能新选择" }];
  if (view.status === "unsupported") return [{ code: "runner_unsupported", message: "该 Runner 未提供本地技能发现能力" }];
  if (view.status === "offline") return [{ code: "runner_offline", message: "本地技能所属 Runner 当前离线" }];
  if (view.status === "incomplete" || !view.complete)
    return [{ code: "catalog_incomplete", message: "本地目录扫描不完整，请刷新后重新核实选择" }];
  if (view.status === "stale")
    return [{ code: "catalog_incomplete", message: "本地目录已过期，请刷新后重新核实选择" }];
  if (sourceSha256 === null) return [];
  const hit = view.entries.some((entry) => entry.kind === "skill" && entry.name === slug && entry.sha256 === sourceSha256);
  if (!hit) return [{ code: "catalog_incomplete", message: "磁盘文件在目录更新后发生变化，需刷新后重新选择" }];
  return [];
}

function versionSummary(version: SkillVersionRow): VersionSummary {
  return {
    id: version.id,
    version: version.version,
    slug: version.slug,
    description: version.description,
    displayName: version.displayName,
    requirements: version.requirements ?? DEFAULT_REQUIREMENTS,
    sha256: version.sha256,
    createdAt: version.createdAt.toISOString(),
  };
}

export function skillIssueMessage(issues: SkillParseIssue[]): string {
  return issues.map((issue) => `${issue.code}: ${issue.message}`).join("；");
}

function sameRequirements(left: SkillExecutionRequirements, right: SkillExecutionRequirements): boolean {
  const canonical = (value: SkillExecutionRequirements) =>
    JSON.stringify({
      allowedModes: [...value.allowedModes].sort(),
      requiredTools: [...value.requiredTools].sort(),
      requiresWorkspace: value.requiresWorkspace,
      requiresPublishing: value.requiresPublishing,
    });
  return canonical(left) === canonical(right);
}
