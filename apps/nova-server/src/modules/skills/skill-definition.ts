import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  skillExecutionRequirementsSchema,
  type SkillApplicability,
  type SkillExecutionRequirements,
  type SkillUnavailabilityCode,
  type SkillUnavailability,
} from "@nova/agent-ui-contracts";

/**
 * SKILL.md 解析与执行配置校验（docs/nova-skills.md §4.1）。
 * 发布 API、本地快照接受与运行准入共用本文件，避免校验规则出现多个来源（P0-C1）。
 */

export const SKILL_NAME_MAX_LENGTH = 64;
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;
/** 本地扫描边界的入口大小上限（§4.3 限制：入口大小；超限标「不完整」而非静默丢弃）。 */
export const SKILL_ENTRY_MAX_BYTES = 256 * 1024;
/** skillsPlugin 注入正文的总量预算（packages/harness 默认 40,000 字符）。 */
export const SKILL_CONTEXT_BUDGET_CHARACTERS = 40_000;

const kebabName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type SkillIssueCode =
  | "missing_frontmatter"
  | "invalid_frontmatter"
  | "missing_name"
  | "missing_description"
  | "invalid_name"
  | "name_too_long"
  | "description_too_long"
  | "empty_body"
  | "too_large"
  | "invalid_requirements";

export type SkillIssue = { code: SkillIssueCode; message: string };
export type SkillParseIssue = SkillIssue;

export type ParsedSkillDefinition = {
  /** frontmatter `name`：小写 kebab-case，与本地目录名一致。 */
  slug: string;
  description: string;
  /** frontmatter 可选 `nova` 字段；省略时应用同一默认值。 */
  requirements: SkillExecutionRequirements;
  /** 规范化后的全文（LF 换行），即发布正文。 */
  body: string;
};

export type SkillParseResult =
  | { ok: true; definition: ParsedSkillDefinition }
  | { ok: false; issues: SkillIssue[] };

/** 换行统一为 LF；正文事实以发布版本为准，规范化保证同内容同摘要（§4.1 版本摘要）。 */
export function normalizeSkillText(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/**
 * 解析 SKILL.md：必需 frontmatter `name`/`description`，可选 `nova` 执行配置（与平台发布配置同一 schema）。
 * 名称与说明只从 frontmatter 派生；正文要求非空但不强制结构。
 */
export function parseSkillMarkdown(input: string): SkillParseResult {
  const issues: SkillIssue[] = [];
  const text = normalizeSkillText(input);
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > SKILL_ENTRY_MAX_BYTES)
    return { ok: false, issues: [{ code: "too_large", message: `Skill entry exceeds ${SKILL_ENTRY_MAX_BYTES} bytes` }] };
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return { ok: false, issues: [{ code: "missing_frontmatter", message: "SKILL.md must start with a '---' frontmatter block" }] };
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1]!, { schema: "core", uniqueKeys: true });
  } catch (error) {
    return {
      ok: false,
      issues: [{ code: "invalid_frontmatter", message: `Frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter))
    return { ok: false, issues: [{ code: "invalid_frontmatter", message: "Frontmatter must be a mapping" }] };
  const record = frontmatter as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || name.trim() === "") issues.push({ code: "missing_name", message: "Frontmatter requires 'name'" });
  else if (name.length > SKILL_NAME_MAX_LENGTH) issues.push({ code: "name_too_long", message: `Skill name exceeds ${SKILL_NAME_MAX_LENGTH} characters` });
  else if (!kebabName.test(name)) issues.push({ code: "invalid_name", message: "Skill name must be lowercase kebab-case" });
  const description = record.description;
  if (typeof description !== "string" || description.trim() === "")
    issues.push({ code: "missing_description", message: "Frontmatter requires 'description'" });
  else if (description.length > SKILL_DESCRIPTION_MAX_LENGTH)
    issues.push({ code: "description_too_long", message: `Skill description exceeds ${SKILL_DESCRIPTION_MAX_LENGTH} characters` });
  const requirementsParse = skillExecutionRequirementsSchema.safeParse(record.nova ?? {});
  if (!requirementsParse.success)
    issues.push({
      code: "invalid_requirements",
      message: `Invalid 'nova' execution requirements: ${requirementsParse.error.issues
        .map((issue) => `${issue.path.join(".") || "nova"}: ${issue.message}`)
        .join("; ")}`,
    });
  const body = text.slice(match[0].length).trim();
  if (body === "") issues.push({ code: "empty_body", message: "SKILL.md body must describe the task method" });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    definition: {
      slug: name as string,
      description: (description as string).trim(),
      requirements: requirementsParse.data as SkillExecutionRequirements,
      body: text,
    },
  };
}

/**
 * 版本摘要 = sha256(规范化正文 + 执行配置 + 资源清单)（§4.1、P0-C2）。
 * canonical JSON 固定键序，保证同内容同摘要、不同内容可用摘要判冲突。
 */
export function skillVersionSha256(
  definition: Pick<ParsedSkillDefinition, "body" | "requirements">,
  resources: readonly { path: string; size: number; sha256: string }[] | null,
): string {
  const canonical = JSON.stringify({
    body: normalizeSkillText(definition.body),
    requirements: {
      allowedModes: [...definition.requirements.allowedModes].sort(),
      requiredTools: [...definition.requirements.requiredTools].sort(),
      requiresWorkspace: definition.requirements.requiresWorkspace,
      requiresPublishing: definition.requirements.requiresPublishing,
    },
    resources: resources
      ? [...resources]
          .map((resource) => ({ path: resource.path, size: resource.size, sha256: resource.sha256.toLowerCase() }))
          .sort((a, b) => a.path.localeCompare(b.path))
      : null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 目录展示与入队校验共用的运行环境上下文（§3 第 4 条、§4.1 执行配置表）。 */
export type SkillAdmissionContext = {
  mode: "plan" | "build" | "auto";
  hasWorkspace: boolean;
  /** 当前宿主按模式实际提供的工具名；requiredTools 只能引用其中已有工具，不注册新工具（红线 1）。 */
  hostToolNames: ReadonlySet<string>;
  /** 产物存储可用性（能力位预占；MinIO 未配置时要求发布文件的技能不可选，§5.3）。 */
  storageConfigured: boolean;
};

/** 静态适用性评估：只收紧宿主能力，返回机器可读原因供目录与选择器展示（§3.1）。 */
export function evaluateSkillApplicability(
  requirements: SkillExecutionRequirements,
  context: SkillAdmissionContext,
): SkillApplicability {
  const reasons: SkillUnavailability[] = [];
  if (!requirements.allowedModes.includes(context.mode))
    reasons.push({
      code: "mode_not_allowed" satisfies SkillUnavailabilityCode,
      message: `技能仅允许模式 ${requirements.allowedModes.join("/")}，当前为 ${context.mode}`,
    });
  if (requirements.requiresWorkspace && !context.hasWorkspace)
    reasons.push({ code: "workspace_required", message: "技能需要绑定工作区" });
  if (requirements.requiresPublishing && !context.storageConfigured)
    reasons.push({ code: "storage_unavailable", message: "文件产出暂不可用" });
  const missingTools = requirements.requiredTools.filter((tool) => !context.hostToolNames.has(tool));
  if (missingTools.length > 0)
    reasons.push({ code: "tools_unavailable", message: `当前环境缺少技能要求的工具：${missingTools.join("、")}` });
  return { status: reasons.length === 0 ? "available" : "unavailable", reasons };
}

/** 入队拒绝时把评估结果转换成明确原因文案；调用方负责抛出 DomainError。 */
export function skillApplicabilityMessage(applicability: SkillApplicability): string {
  return applicability.reasons.map((reason) => reason.message).join("；");
}
