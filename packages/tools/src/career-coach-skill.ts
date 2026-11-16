import { readFileSync } from "node:fs";
import type { SkillResource } from "@nnova/harness/plugins/skills";

export const careerCoachSkill: SkillResource = {
  id: "nova.career-coach",
  version: "1.0.0",
  description: "根据真实经历和目标岗位修改简历，开展逐题模拟面试并复盘。",
  content: readFileSync(new URL("../skills/career-coach/SKILL.md", import.meta.url), "utf8"),
};
