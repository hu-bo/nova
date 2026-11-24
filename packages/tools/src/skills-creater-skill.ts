import { readFileSync } from "node:fs";
import type { SkillResource } from "@nnova/harness/plugins/skills";

/** 内置技能创建助手（docs/nova-skills.md §4.4）：运行时 ID 固定 `nova.skills-creater`，展示名「技能创建助手」。 */
export const skillsCreaterSkill: SkillResource = {
  id: "nova.skills-creater",
  version: "1.0.0",
  description:
    "创建、改写或整理供 Nova 使用的技能；把可重复任务沉淀为 SKILL.md，默认安装为项目技能，全局安装仅在用户明确要求时进行。仅讨论技能概念、或要求修改产品内置技能时不应触发。",
  content: readFileSync(new URL("../skills/skills-creater/SKILL.md", import.meta.url), "utf8"),
};
