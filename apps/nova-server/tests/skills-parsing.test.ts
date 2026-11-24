import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluateSkillApplicability,
  parseSkillMarkdown,
  skillVersionSha256,
  SKILL_CONTEXT_BUDGET_CHARACTERS,
} from "../src/modules/skills/skill-definition.js";

const valid = `---
name: test-report
description: 根据项目现有测试结果生成报告，区分通过、失败与未执行的检查。
---

从项目脚本和现有测试中确认验证入口，先列明验证范围。
`;

test("parses a valid SKILL.md with defaults applied", () => {
  const parsed = parseSkillMarkdown(valid);
  assert.ok(parsed.ok, JSON.stringify(parsed.issues));
  assert.equal(parsed.definition.slug, "test-report");
  assert.match(parsed.definition.description, /^根据项目现有测试结果/);
  assert.deepEqual(parsed.definition.requirements, {
    allowedModes: ["plan", "build", "auto"],
    requiredTools: [],
    requiresWorkspace: false,
    requiresPublishing: false,
  });
});

test("normalizes CRLF so the same content hashes identically", () => {
  const crlf = valid.replace(/\n/g, "\r\n");
  const a = parseSkillMarkdown(valid);
  const b = parseSkillMarkdown(crlf);
  assert.ok(a.ok && b.ok);
  assert.equal(skillVersionSha256(a.definition, null), skillVersionSha256(b.definition, null));
  // 执行配置与资源清单参与摘要：任何一份事实变化都必须产生新摘要（§4.1）。
  assert.notEqual(
    skillVersionSha256(a.definition, null),
    skillVersionSha256({ ...a.definition, requirements: { ...a.definition.requirements, requiresWorkspace: true } }, null),
  );
  assert.notEqual(
    skillVersionSha256(a.definition, null),
    skillVersionSha256(a.definition, [{ path: "references/a.md", size: 10, sha256: "a".repeat(64) }]),
  );
});

test("rejects missing fields, invalid names and overlong values with structured reasons", () => {
  const missingName = parseSkillMarkdown(valid.replace("name: test-report\n", ""));
  assert.ok(!missingName.ok && missingName.issues.some((issue) => issue.code === "missing_name"));
  const missingDescription = parseSkillMarkdown(valid.replace("description: 根据项目现有测试结果生成报告，区分通过、失败与未执行的检查。\n", ""));
  assert.ok(!missingDescription.ok && missingDescription.issues.some((issue) => issue.code === "missing_description"));
  const noFrontmatter = parseSkillMarkdown("# 标题\n正文");
  assert.ok(!noFrontmatter.ok && noFrontmatter.issues.some((issue) => issue.code === "missing_frontmatter"));
  const badName = parseSkillMarkdown(valid.replace("name: test-report", "name: Test_Report"));
  assert.ok(!badName.ok && badName.issues.some((issue) => issue.code === "invalid_name"));
  const longName = parseSkillMarkdown(valid.replace("name: test-report", `name: ${"a".repeat(65)}`));
  assert.ok(!longName.ok && longName.issues.some((issue) => issue.code === "name_too_long"));
  const emptyBody = parseSkillMarkdown("---\nname: x\ndescription: y\n---\n\n");
  assert.ok(!emptyBody.ok && emptyBody.issues.some((issue) => issue.code === "empty_body"));
});

test("validates the optional nova execution requirements and rejects unknown fields", () => {
  const withNova = parseSkillMarkdown(
    `---
name: report-builder
description: 生成测试报告文件。
nova:
  allowedModes: [build, auto]
  requiredTools: [bash, write_file]
  requiresWorkspace: true
  requiresPublishing: true
---

写入 outputDir 后发布。
`,
  );
  assert.ok(withNova.ok, JSON.stringify(withNova.issues));
  assert.deepEqual(withNova.definition.requirements, {
    allowedModes: ["build", "auto"],
    requiredTools: ["bash", "write_file"],
    requiresWorkspace: true,
    requiresPublishing: true,
  });
  const unknown = parseSkillMarkdown(
    `---
name: r
description: d
nova:
  allowedModes: [build]
  sandbox: true
---

正文
`,
  );
  assert.ok(!unknown.ok && unknown.issues.some((issue) => issue.code === "invalid_requirements"));
  const emptyModes = parseSkillMarkdown(
    `---
name: r
description: d
nova:
  allowedModes: []
---

正文
`,
  );
  assert.ok(!emptyModes.ok && emptyModes.issues.some((issue) => issue.code === "invalid_requirements"));
});

test("static applicability evaluation returns machine-readable reasons", () => {
  const requirements = parseSkillMarkdown(
    `---
name: r
description: d
nova:
  allowedModes: [build, auto]
  requiredTools: [bash]
  requiresWorkspace: true
  requiresPublishing: true
---

正文
`,
  );
  assert.ok(requirements.ok);
  const blocked = evaluateSkillApplicability(requirements.definition.requirements, {
    mode: "plan",
    hasWorkspace: false,
    hostToolNames: new Set(["read_file"]),
    storageConfigured: false,
  });
  assert.equal(blocked.status, "unavailable");
  assert.deepEqual(
    blocked.reasons.map((reason) => reason.code).sort(),
    ["mode_not_allowed", "storage_unavailable", "tools_unavailable", "workspace_required"].sort(),
  );
  const ok = evaluateSkillApplicability(requirements.definition.requirements, {
    mode: "auto",
    hasWorkspace: true,
    hostToolNames: new Set(["bash", "write_file"]),
    storageConfigured: true,
  });
  assert.equal(ok.status, "available");
  assert.equal(ok.reasons.length, 0);
  // 预算常量与 skillsPlugin 默认一致（§6 第 5 段）。
  assert.equal(SKILL_CONTEXT_BUDGET_CHARACTERS, 40_000);
});
