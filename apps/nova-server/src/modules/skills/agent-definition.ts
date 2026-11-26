import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { normalizeSkillText } from "./skill-definition.js";

/**
 * 本地 Agent 配置解析（docs/design/nova-skills.md §4.3 Agent 配置、P0-E4）。
 * `~/.nova/agents/<name>.md` / `.nova/agents/<name>.md`：名称取文件名，`description` 必填，
 * 正文为角色提示；可选 modelId、工具限制（只缩小宿主能力）与技能名称引用。
 * 未支持字段（如 OpenCode `mode: subagent/all`）报告不兼容，不静默加载；
 * Agent 不能覆盖模式、审批或平台基础指令（红线 1）。
 */

export const AGENT_FILE_MAX_BYTES = 64 * 1024;
const kebabName = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type AgentParseIssue = { code: "invalid_frontmatter" | "missing_description" | "invalid_name" | "name_mismatch" | "unsupported_field" | "invalid_model" | "invalid_tools" | "empty_body" | "too_large"; message: string };

export type ParsedAgentDefinition = {
  /** 取文件名（去 .md），须为小写 kebab-case。 */
  name: string;
  description: string;
  /** 角色提示正文（frontmatter 之外）。 */
  body: string;
  /** 可选模型 ID：必须是用户已有模型配置（接受时校验）。 */
  modelId?: string;
  /** 工具限制：只允许缩小宿主能力（disallow 列表）。 */
  disallowTools: string[];
  /** 技能名称引用：仅作为界面预选建议（§4.3）。 */
  skillRefs: string[];
};

export type AgentParseResult = { ok: true; definition: ParsedAgentDefinition } | { ok: false; issues: AgentParseIssue[] };

/** 来源身份 → 稳定 Agent 引用 ID（两个 Runner 上的同名 Agent 不是同一资源，§4.3）。 */
export function agentRefId(input: {
  ownerUserId: string;
  runnerRowId: string;
  scope: "global" | "project";
  workspaceId: string;
  relativeDir: string;
  name: string;
}): string {
  return createHash("sha256")
    .update([input.ownerUserId, input.runnerRowId, input.scope, input.workspaceId, input.relativeDir, input.name].join("\u0000"), "utf8")
    .digest("hex");
}

/** 内容摘要 → 语义兼容版本号 `0.0.<n>`（与本地技能 0.0.<revision> 同形状；同摘要同版本）。 */
export function agentVersionFromSha(sha256: string): string {
  const digits = BigInt(`0x${sha256.slice(0, 12)}`).toString(10);
  return `0.0.${digits}`;
}

export function parseAgentMarkdown(input: string, fileName: string): AgentParseResult {
  const issues: AgentParseIssue[] = [];
  const text = normalizeSkillText(input);
  if (Buffer.byteLength(text, "utf8") > AGENT_FILE_MAX_BYTES)
    return { ok: false, issues: [{ code: "too_large", message: `Agent file exceeds ${AGENT_FILE_MAX_BYTES} bytes` }] };
  const baseName = fileName.replace(/\.md$/i, "").trim();
  if (!kebabName.test(baseName) || baseName.length > 64)
    return { ok: false, issues: [{ code: "invalid_name", message: "Agent file name must be lowercase kebab-case within 64 characters" }] };
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!match) return { ok: false, issues: [{ code: "invalid_frontmatter", message: "Agent file must start with a '---' frontmatter block" }] };
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
  if (record.name !== undefined && record.name !== baseName)
    issues.push({ code: "name_mismatch", message: `Frontmatter name must match the file name (${baseName})` });
  const description = record.description;
  if (typeof description !== "string" || description.trim() === "")
    issues.push({ code: "missing_description", message: "Agent frontmatter requires 'description'" });
  const modelId = record.modelId ?? record.model;
  if (modelId !== undefined && (typeof modelId !== "string" || modelId.trim() === ""))
    issues.push({ code: "invalid_model", message: "modelId must be a non-empty string" });
  const disallowTools: string[] = [];
  if (record.tools !== undefined) {
    if (Array.isArray(record.tools) && record.tools.every((tool) => typeof tool === "string"))
      disallowTools.push(...(record.tools as string[]));
    else if (record.tools && typeof record.tools === "object" && !Array.isArray(record.tools)) {
      for (const [tool, enabled] of Object.entries(record.tools as Record<string, unknown>))
        if (enabled === false) disallowTools.push(tool);
    } else issues.push({ code: "invalid_tools", message: "tools must be a list or a name→boolean map" });
  }
  const skillRefs: string[] = [];
  for (const value of [record.skill, record.skills]) {
    if (value === undefined) continue;
    if (typeof value === "string") skillRefs.push(value.trim());
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) skillRefs.push(...(value as string[]));
    else issues.push({ code: "unsupported_field", message: "skill references must be names or a list of names" });
  }
  // 首期只支持主 Agent profile；OpenCode 子 Agent 语义如实报告不兼容，不当作可执行子 Agent 加载。
  if (record.mode !== undefined && record.mode !== "primary" && record.mode !== "chat")
    issues.push({ code: "unsupported_field", message: `Agent mode '${String(record.mode)}' is not supported; only primary chat profiles load in this release` });
  const body = text.slice(match[0].length).trim();
  if (body === "") issues.push({ code: "empty_body", message: "Agent body must contain the role prompt" });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    definition: {
      name: baseName,
      description: (description as string).trim(),
      body,
      ...(typeof modelId === "string" ? { modelId: modelId.trim() } : {}),
      disallowTools,
      skillRefs,
    },
  };
}

/**
 * 已接受的 Agent 目录条目：目录发布时经快照解析，随连接态持有（§8.1）。
 * refId 由来源身份派生（owner/runner/scope/workspace/cwd/name），
 * version 由入口文件摘要派生（`0.0.<n>`，n 为摘要前 12 位十六进制的十进制值）：
 * 同一内容 → 同一版本引用，客户端选择时提交 `{source, refId, version}`，服务端按此固定正文。
 */
export type AcceptedAgentCatalog = {
  refId: string;
  version: string;
  /** 本地来源仅有两种。 */
  source: "runner-global" | "runner-project";
  runnerRowId: string;
  workspaceId: string | null;
  relativeCwd: string | null;
  name: string;
  description: string;
  sha256: string;
  /** 解析成功时的固定正文与元数据；解析失败为 null，条目仍展示不兼容原因。 */
  definition: ParsedAgentDefinition | null;
  incompatibilities: AgentParseIssue[];
};

/** 已接受的 Agent 配置：与已选技能一起固定到执行快照（§6）。 */
export type AcceptedAgentProfile = {
  source: "runner-global" | "runner-project";
  refId: string;
  version: string;
  name: string;
  description: string;
  /** 固定下来的角色提示正文（恢复时禁止重读磁盘）。 */
  systemPrompt: string;
  modelId?: string;
  disallowTools?: string[];
};
