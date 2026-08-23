import { readFileSync } from "node:fs";
import { parseSkillDocument, type SkillDocument } from "./schema.js";

const BUILTIN_SKILL_FILES = Object.freeze([
  "minimal-change-engineering.json",
  "codebase-reconnaissance.json",
  "root-cause-debugging.json",
  "behavioral-verification.json",
  "change-cleanup-review.json",
  "concurrency-lifecycle-safety.json",
]);

export function loadBuiltinSkills(): readonly SkillDocument[] {
  return Object.freeze(BUILTIN_SKILL_FILES.map(file => {
    const source = readFileSync(new URL(`../skills/${file}`, import.meta.url), "utf8");
    return parseSkillDocument(JSON.parse(source));
  }));
}
