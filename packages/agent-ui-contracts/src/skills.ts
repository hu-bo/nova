import { z } from "zod";

/** 资源引用 ID 的形状与 `messages.ts` 的 `idSchema` 一致；此处独立定义以避免模块循环求值。 */
const idSchema = z.string().min(1).max(128);

/**
 * Skills 共享契约（docs/design/nova-skills.md §4.1、§8.1）。
 *
 * 运行时 ID 约定：内置技能保留 `nova.*` 确切 ID（如 `nova.spec`、`nova.skills-creater`），
 * 磁盘同名文件不能替换；用户技能运行时 ID 为 `skill.<平台UUID>`，避免以数字开头的 UUID
 * 直接传给 Harness 插件。数据库 ID、显示名称与运行时 ID 的转换只在服务端适配处完成。
 * 无语义版本号的本地文件由服务端映射到递增的 `0.0.<revision>`；契约只承诺版本号格式。
 */
export const skillVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export const skillSourceSchema = z.enum(["builtin", "platform", "runner-global", "runner-project"]);
export type SkillSource = z.infer<typeof skillSourceSchema>;

export const skillSelectionSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: skillVersionSchema,
  })
  .strict();
export const productSkillSchema = skillSelectionSchema
  .extend({
    name: z.string(),
    description: z.string(),
    source: skillSourceSchema,
  })
  .strict();

/** Agent profile：保留旧聊天 `{ id: "chat", version }` 兼容分支；Agent 内容由服务端按来源与版本解析，客户端不能传任意 system prompt（§4.3）。 */
export const agentProfileSchema = z.union([
  z
    .object({
      id: z.literal("chat"),
      version: skillVersionSchema,
    })
    .strict(),
  z
    .object({
      source: z.enum(["platform", "runner-global", "runner-project"]),
      refId: idSchema,
      version: skillVersionSchema,
    })
    .strict(),
]);
export const CHAT_AGENT_PROFILE = { id: "chat", version: "1.0.0" } as const;

/** 缺省即同一默认执行要求（省略时应用同一默认值，§4.1）。 */
export const skillExecutionRequirementsSchema = z
  .object({
    allowedModes: z.array(z.enum(["plan", "build", "auto"])).min(1).default(["plan", "build", "auto"]),
    requiredTools: z.array(z.string().min(1).max(64)).default([]),
    requiresWorkspace: z.boolean().default(false),
    requiresPublishing: z.boolean().default(false),
  })
  .strict()
  .default({ allowedModes: ["plan", "build", "auto"], requiredTools: [], requiresWorkspace: false, requiresPublishing: false });

/** 技能在当前环境不适用的机器可读原因；文案由服务端给出，客户端不手写枚举映射（§3.1）。 */
export const skillUnavailabilityCodeSchema = z.enum([
  "disabled",
  "version_unavailable",
  "mode_not_allowed",
  "tools_unavailable",
  "workspace_required",
  "storage_unavailable",
  "runner_offline",
  "runner_unsupported",
  "catalog_incomplete",
  "budget_exceeded",
  "platform_not_supported",
  "out_of_scope",
]);
export const skillUnavailabilitySchema = z
  .object({
    code: skillUnavailabilityCodeSchema,
    message: z.string().min(1),
  })
  .strict();
/** 适用性三态：满足 / 不满足 / 待验证（§4.2 环境声明与准入；未探测不等于不满足）。 */
export const skillApplicabilitySchema = z
  .object({
    status: z.enum(["available", "unavailable", "unverified"]),
    reasons: z.array(skillUnavailabilitySchema).default([]),
  })
  .strict();

/** 被同名项目技能遮蔽的来源标注（§4.3 身份与覆盖）：遮蔽项仍返回，显示遮蔽来源。 */
export const skillShadowSchema = z
  .object({
    name: z.string(),
    source: skillSourceSchema,
    runnerId: idSchema.nullable().default(null),
    projectId: idSchema.nullable().default(null),
  })
  .strict();

/** 本地源目录整体状态（§4.3 时机与诊断）；UI 区分「扫描中/不完整/过期/离线/不支持」，不当作「用户没有技能」。 */
export const skillCatalogStatusSchema = z.enum(["ready", "scanning", "incomplete", "stale", "offline", "unsupported"]);

/** 本地扫描诊断条目（§4.3）；服务端透传 Runner 诊断供目录与详情面板展示。 */
export const skillCatalogDiagnosticSchema = z
  .object({
    code: z.enum([
      "missing_home",
      "permission_denied",
      "invalid_frontmatter",
      "file_too_large",
      "duplicate_name",
      "path_escape",
      "truncated",
      "scan_timeout",
      "scan_error",
    ]),
    message: z.string().min(1),
    name: z.string().optional(),
    path: z.string().optional(),
  })
  .strict();

/** 资源包清单条目（§4.2）：只记路径/大小/摘要，不复制正文事实；P2 前列表为空。 */
export const skillResourceEntrySchema = z
  .object({
    path: z.string().min(1).max(512),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i),
  })
  .strict();

/** 合并目录条目摘要（§3.1、§8.2）：列表只回这些字段，正文走版本详情按需读取。 */
export const skillCatalogEntrySchema = productSkillSchema
  .extend({
    requirements: skillExecutionRequirementsSchema,
    /** 关联项目（platform 项目技能 / runner-project）。 */
    projectId: idSchema.nullable().default(null),
    /** 本地来源定位：Runner、注册工作区与相对 canonicalCwd 的项目目录标识。 */
    runnerId: idSchema.nullable().default(null),
    workspaceId: idSchema.nullable().default(null),
    cwd: z.string().max(1024).nullable().default(null),
    /** 内容摘要：本地条目为入口文件当前目录摘要，平台/内置为版本摘要。 */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .default(null),
    applicability: skillApplicabilitySchema,
    disabled: z.boolean().default(false),
    shadowedBy: skillShadowSchema.optional(),
  })
  .strict();

/** 版本详情（§3.1 详情面板）：正文 + 执行要求 + 资源清单 + 本地目录诊断。 */
export const skillVersionDetailSchema = skillCatalogEntrySchema.extend({
  body: z.string(),
  resources: z.array(skillResourceEntrySchema).default([]),
  diagnostics: z.array(skillCatalogDiagnosticSchema).default([]),
});

/** Agent 目录条目（§4.3 Agent 配置、§8.2 `GET /agents`）：正文按需读取；技能引用只是界面预选建议。 */
export const agentCatalogEntrySchema = z
  .object({
    refId: idSchema,
    name: z.string(),
    description: z.string(),
    source: z.enum(["platform", "runner-global", "runner-project"]),
    version: skillVersionSchema,
    /** 按同一项目目录顺序解析出的技能名称预选建议；发送仍须显式提交技能引用。 */
    suggestedSkill: z.string().optional(),
    modelId: idSchema.optional(),
    /** 与本地环境兼容性问题（如 OpenCode `mode: subagent` 未支持字段）；不为空则不可选择。 */
    incompatibilities: z.array(skillUnavailabilitySchema).default([]),
    runnerId: idSchema.nullable().default(null),
    workspaceId: idSchema.nullable().default(null),
    cwd: z.string().max(1024).nullable().default(null),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable()
      .default(null),
  })
  .strict();

export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export type ProductSkill = z.infer<typeof productSkillSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type SkillExecutionRequirements = z.infer<typeof skillExecutionRequirementsSchema>;
export type SkillUnavailability = z.infer<typeof skillUnavailabilitySchema>;
export type SkillUnavailabilityCode = z.infer<typeof skillUnavailabilityCodeSchema>;
export type SkillApplicability = z.infer<typeof skillApplicabilitySchema>;
export type SkillCatalogStatus = z.infer<typeof skillCatalogStatusSchema>;
export type SkillCatalogDiagnostic = z.infer<typeof skillCatalogDiagnosticSchema>;
export type SkillResourceEntry = z.infer<typeof skillResourceEntrySchema>;
export type SkillCatalogEntry = z.infer<typeof skillCatalogEntrySchema>;
export type SkillVersionDetail = z.infer<typeof skillVersionDetailSchema>;
export type AgentCatalogEntry = z.infer<typeof agentCatalogEntrySchema>;
