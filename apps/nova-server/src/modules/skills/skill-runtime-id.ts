import type { SkillSource } from "@nova/agent-ui-contracts";

/**
 * 运行时 ID 适配（docs/nova-skills.md §4.1 末段、P0-C5）。
 * 数据库 UUID ↔ 展示名 ↔ Harness 运行时 ID 的转换**只在本文件**完成，其它层不拼接前缀。
 * - 内置保留确切 ID（`nova.spec`、`nova.career-coach`），磁盘同名文件不能替换（§4.3）。
 * - 用户技能运行时 ID 为 `skill.<平台UUID>`，避免以数字开头的 UUID 直接传给插件。
 */

/** Harness skillsPlugin 的 ID 约束：字母开头，允许 `.`/`-`/`_`/字母数字。 */
const RUNTIME_ID = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;

/** 内置技能的确切运行时 ID（保护名单）。 */
export const BUILTIN_RUNTIME_IDS = {
  spec: "nova.spec",
  careerCoach: "nova.career-coach",
  skillsCreater: "nova.skills-creater",
} as const;

/** 内置：`<slug>` → `nova.<slug>`；用户：数据库 UUID → `skill.<uuid>`。 */
export function toRuntimeSkillId(source: SkillSource, idOrSlug: string): string {
  if (source === "builtin") {
    const runtimeId = idOrSlug.startsWith("nova.") ? idOrSlug : `nova.${idOrSlug}`;
    if (!RUNTIME_ID.test(runtimeId)) throw new Error(`Built-in runtime id is not a valid Harness skill id: ${runtimeId}`);
    return runtimeId;
  }
  // 用户技能统一加 `skill.` 前缀，即使 UUID 以数字开头也不会泄露为裸 UUID。
  const runtimeId = `skill.${idOrSlug}`;
  if (!RUNTIME_ID.test(runtimeId)) throw new Error(`Runtime skill id is not a valid Harness skill id: ${runtimeId}`);
  return runtimeId;
}

/** 从运行时 ID 反解出来源与数据库标识（快照恢复、工具装配用）。 */
export function parseRuntimeSkillId(runtimeId: string): { source: SkillSource; key: string } | undefined {
  if (runtimeId.startsWith("nova.")) return { source: "builtin", key: runtimeId };
  if (runtimeId.startsWith("skill.")) return { source: "platform", key: runtimeId.slice("skill.".length) };
  return undefined;
}

/**
 * 覆盖解析顺序「项目 > 当前 Runner 全局 > 普通内置」的展示键（§4.3 身份与覆盖）。
 * 平台来源为独立显式选择，不参与同名磁盘覆盖，故不进入 name-key 冲突判定。
 * 内置确切 ID 永不进入磁盘 name-key 空间，因此同名文件无法遮蔽或替换 `nova.*`。
 */
export type SkillNameKeyScope = "project" | "global" | "builtin";
const OVERLAY_PRIORITY: Record<SkillNameKeyScope, number> = { project: 3, global: 2, builtin: 1 };

export function skillNameKey(source: SkillSource, slug: string): string {
  // 磁盘来源与内置共用 slug 空间；平台来源不参与覆盖，单独命名空间隔离。
  return source === "platform" ? `platform:${slug}` : `disk:${slug}`;
}

export function overlayWins(candidate: SkillNameKeyScope, incumbent: SkillNameKeyScope): boolean {
  return OVERLAY_PRIORITY[candidate] > OVERLAY_PRIORITY[incumbent];
}
