import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_AGENT_PROFILE,
  agentProfileSchema,
  applyEvent,
  messageSchema,
  productSkillSchema,
  runViewSchema,
  skillCatalogEntrySchema,
  skillSelectionSchema,
  skillVersionDetailSchema,
  type ProductEvent,
  type Snapshot,
} from "../src/index.js";

const baseSnapshot: Snapshot = {
  conversation: {
    id: "conversation",
    title: null,
    mode: "chat",
    projectId: null,
    epoch: 1,
    configuration: { backendId: "nova", modelId: null, mode: "build" },
  },
  cursor: "0",
  messages: [],
  run: null,
  operations: [],
  interactions: [],
  pendingInputs: [],
  capabilities: {
    tools: true,
    approval: true,
    question: true,
    steering: true,
    resume: true,
    compact: false,
    images: false,
    files: true,
  },
};

const commitEvent = (message: unknown, sequence: string): ProductEvent =>
  ({
    sequence,
    runId: null,
    type: "message.committed",
    payload: { message },
  }) as unknown as ProductEvent;

test("skill source accepts builtin, platform and runner-local origins while keeping legacy builtin data", () => {
  const legacy = { id: "nova.career-coach", version: "1.0.0", name: "求职教练", description: "简历辅导", source: "builtin" };
  assert.deepEqual(productSkillSchema.parse(legacy), legacy);
  for (const source of ["platform", "runner-global", "runner-project"] as const) {
    assert.equal(productSkillSchema.safeParse({ ...legacy, id: "0b9c6d3e-1f2a-4b5c-8d7e-6f5a4b3c2d1e", source }).success, true);
  }
  assert.equal(productSkillSchema.safeParse({ ...legacy, source: "marketplace" }).success, false);
  assert.equal(skillSelectionSchema.safeParse({ id: "skill.x", version: "1.0" }).success, false);
});

test("message and run read models carry the skill reference in all three forms", () => {
  const userMessage = (skill?: unknown) => ({
    id: `message-${skill ? "with" : "without"}-skill`,
    runId: null,
    sequence: "1",
    role: "user",
    state: "completed",
    blocks: [{ id: "block-1", type: "text", text: "hello" }],
    createdAt: new Date().toISOString(),
    ...(skill ? { skill } : {}),
  });
  const forms: unknown[] = [
    undefined,
    { id: "nova.spec", version: "2.1.0", name: "规格驱动", description: "按 Spec 工作", source: "builtin" },
    {
      id: "0b9c6d3e-1f2a-4b5c-8d7e-6f5a4b3c2d1e",
      version: "0.0.7",
      name: "test-report",
      description: "生成测试报告",
      source: "runner-project",
    },
  ];
  for (const [index, form] of forms.entries()) {
    const message = userMessage(form);
    assert.ok(messageSchema.safeParse(message).success, `message form ${index}`);
    const next = applyEvent(baseSnapshot, commitEvent(message, "1"));
    const stored = next.messages.find((item) => item.id === message.id);
    assert.ok(stored);
    if (form === undefined) assert.equal(stored.skill, undefined);
    else assert.deepEqual(stored.skill, productSkillSchema.parse(form));
  }
  assert.ok(
    runViewSchema.safeParse({
      id: "run-1",
      state: "running",
      skill: { id: "nova.spec", version: "2.1.0", name: "规格驱动", description: "按 Spec 工作", source: "builtin" },
    }).success,
  );
  assert.ok(runViewSchema.safeParse({ id: "run-1", state: "queued" }).success);
});

test("agent profile keeps the chat compatibility branch and only takes sourced references", () => {
  assert.ok(agentProfileSchema.safeParse(CHAT_AGENT_PROFILE).success);
  assert.ok(
    agentProfileSchema.safeParse({ source: "runner-global", refId: "agent-ref-1", version: "0.0.1" }).success,
  );
  // 客户端不能传任意 system prompt，也不允许未知来源。
  assert.equal(agentProfileSchema.safeParse({ ...CHAT_AGENT_PROFILE, systemPrompt: "override" }).success, false);
  assert.equal(agentProfileSchema.safeParse({ source: "builtin", refId: "x", version: "0.0.1" }).success, false);
  assert.equal(agentProfileSchema.safeParse({ refId: "x", version: "0.0.1" }).success, false);
});

test("catalog entries carry requirements, applicability and shadow info with defaults", () => {
  const entry = skillCatalogEntrySchema.parse({
    id: "0b9c6d3e-1f2a-4b5c-8d7e-6f5a4b3c2d1e",
    version: "0.0.3",
    name: "repo-review",
    description: "仓库审查",
    source: "runner-project",
    applicability: { status: "unavailable", reasons: [{ code: "mode_not_allowed", message: "Plan 模式不能写文件" }] },
    shadowedBy: { name: "repo-review", source: "runner-project", projectId: "project-1" },
  });
  assert.deepEqual(entry.requirements, {
    allowedModes: ["plan", "build", "auto"],
    requiredTools: [],
    requiresWorkspace: false,
    requiresPublishing: false,
  });
  assert.equal(entry.projectId, null);
  assert.equal(entry.runnerId, null);
  assert.equal(entry.disabled, false);
  assert.equal(entry.applicability.reasons[0]?.code, "mode_not_allowed");
  assert.equal(
    skillCatalogEntrySchema.safeParse({ ...entry, requirements: { allowedModes: [], requiredTools: [] } }).success,
    false,
  );
  const detail = skillVersionDetailSchema.parse({ ...entry, body: "# 步骤" });
  assert.deepEqual(detail.resources, []);
  assert.deepEqual(detail.diagnostics, []);
});
