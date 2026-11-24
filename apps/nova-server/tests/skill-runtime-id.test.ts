import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_RUNTIME_IDS,
  overlayWins,
  skillNameKey,
  toRuntimeSkillId,
} from "../src/modules/skills/skill-runtime-id.js";

test("builtin keeps the exact nova.* runtime id, user skills always take the skill. prefix", () => {
  assert.equal(toRuntimeSkillId("builtin", "spec"), "nova.spec");
  assert.equal(toRuntimeSkillId("builtin", "nova.spec"), "nova.spec");
  assert.equal(BUILTIN_RUNTIME_IDS.skillsCreater, "nova.skills-creater");
  // 数字开头的 UUID 不允许以裸 ID 泄露到插件层。
  const numericStart = "7b3f9a2e-0000-4000-8000-000000000000";
  const runtimeId = toRuntimeSkillId("platform", numericStart);
  assert.equal(runtimeId, `skill.${numericStart}`);
  assert.match(runtimeId, /^[a-zA-Z]/);
  for (const source of ["runner-global", "runner-project"] as const)
    assert.equal(toRuntimeSkillId(source, numericStart), `skill.${numericStart}`);
});

test("name-key space separates platform skills from disk overlay", () => {
  // 磁盘同名覆盖判定共用 disk 命名空间（项目 > 全局 > 普通内置）；
  // 平台来源独立命名空间；内置的确切 ID「调用」不受影响（运行时 ID 固定 nova.*）。
  assert.equal(skillNameKey("runner-project", "review"), skillNameKey("runner-global", "review"));
  assert.equal(skillNameKey("builtin", "spec"), skillNameKey("runner-project", "spec"));
  assert.notEqual(skillNameKey("platform", "review"), skillNameKey("runner-project", "review"));
  assert.ok(overlayWins("project", "global"));
  assert.ok(!overlayWins("global", "project"));
  assert.ok(overlayWins("global", "builtin"));
  assert.ok(!overlayWins("builtin", "project"));
});
