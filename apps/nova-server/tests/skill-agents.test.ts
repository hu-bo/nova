import assert from "node:assert/strict";
import test from "node:test";
import { agentVersionFromSha, parseAgentMarkdown } from "../src/modules/skills/agent-definition.js";
import { SkillService } from "../src/modules/skills/skill.service.js";
import type { LocalCatalogEntry, LocalCatalogView } from "../src/modules/skills/skill-directory.js";
import { fakeDirectory, pinEnvironment, repository, viewInput } from "./skill-fakes.js";

const agentFile = (description = "资深审查者", body = "关注边界与失败路径。", extra = "") =>
  `---\ndescription: ${description}\n${extra}---\n\n${body}\n`;

test("agent parser: name from file, description required, unsupported fields flagged", () => {
  const ok = parseAgentMarkdown(agentFile(), "reviewer.md");
  assert.ok(ok.ok && ok.definition.name === "reviewer");
  const withOptions = parseAgentMarkdown(agentFile("审查", "正文", "modelId: model-1\ntools:\n  write_file: false\n  bash: false\nskill: test-report\n"), "reviewer.md");
  assert.ok(withOptions.ok);
  assert.equal(withOptions.definition.modelId, "model-1");
  assert.deepEqual(withOptions.definition.disallowTools, ["write_file", "bash"]);
  assert.deepEqual(withOptions.definition.skillRefs, ["test-report"]);
  const missingDescription = parseAgentMarkdown("---\nname: reviewer\n---\n\n正文\n", "reviewer.md");
  assert.ok(!missingDescription.ok && missingDescription.issues.some((issue) => issue.code === "missing_description"));
  const badName = parseAgentMarkdown(agentFile(), "Reviewer Notes.md");
  assert.ok(!badName.ok && badName.issues.some((issue) => issue.code === "invalid_name"));
  // OpenCode 子 Agent 语义：报告不兼容而不是静默加载（§4.3）。
  const subagent = parseAgentMarkdown(agentFile("审查", "正文", "mode: subagent\n"), "reviewer.md");
  assert.ok(!subagent.ok && subagent.issues.some((issue) => issue.code === "unsupported_field"));
});

test("agent version derives from content digest and is stable", () => {
  const a = agentVersionFromSha("0".repeat(64));
  assert.match(a, /^0\.0\.\d+$/);
  assert.equal(a, agentVersionFromSha("0".repeat(64)));
  assert.notEqual(a, agentVersionFromSha("1".repeat(64)));
});

async function agentFixture() {
  const snapshots = new Map<string, string>();
  const views = new Map<string, LocalCatalogView>();
  const directory = fakeDirectory(views, snapshots);
  const service = new SkillService(repository(), directory, { storageConfigured: true }, {
    validateSelection: async (id: string | null) => {
      if (id === "missing-model") throw new Error("model unavailable");
    },
  });
  const entry: LocalCatalogEntry = {
    kind: "agent",
    scope: "global",
    workspaceId: "",
    relativeDir: "",
    name: "reviewer",
    description: "资深审查者",
    sha256: "e".repeat(64),
    sizeBytes: 100,
  };
  return { snapshots, views, directory, service, entry };
}

test("agents are accepted at publish, listed with compatibility and pinned by version", async () => {
  const { snapshots, views, directory, service, entry } = await agentFixture();
  snapshots.set(entry.sha256, agentFile("资深审查者", "关注边界与失败路径。", "modelId: model-1\n"));
  const accepted = await service.accept({
    ownerUserId: "owner-1",
    runnerRowId: "runner-1",
    entries: [entry],
    readSnapshot: (item) => directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry: item }),
  });
  const item = accepted.agents[0];
  assert.ok(item && item.definition);
  // 生产链路由 RunnerLocalResources 把接受结果写入连接态视图；替身按同样语义设置。
  views.set("owner-1/runner-1", viewInput({ agents: accepted.agents }, [entry]));

  const listed = service.listAgents({ ownerUserId: "owner-1", runnerRowId: "runner-1", workspaceId: null, relativeCwd: null });
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.refId, item!.refId);
  assert.equal(listed[0]!.version, item!.version);

  const pinned = await service.pinAgent({ source: "runner-global", refId: item!.refId, version: item!.version }, pinEnvironment({ runnerRowId: "runner-1" }));
  assert.equal(pinned.name, "reviewer");
  assert.equal(pinned.systemPrompt, "关注边界与失败路径。");
  assert.equal(pinned.modelId, "model-1");
  assert.equal(pinned.source, "runner-global");

  // 内容变化 -> 版本变化，旧引用不再命中（按版本固定，恢复禁止重读磁盘）。
  const changed: LocalCatalogEntry = { ...entry, sha256: "f".repeat(64) };
  snapshots.set(changed.sha256, agentFile("资深审查者", "全新的角色说明。"));
  const reaccepted = await service.accept({
    ownerUserId: "owner-1",
    runnerRowId: "runner-1",
    entries: [changed],
    readSnapshot: (each) => directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry: each }),
  });
  assert.notEqual(reaccepted.agents[0]!.version, item!.version);
  views.set("owner-1/runner-1", viewInput({ agents: reaccepted.agents }, [changed]));
  await assert.rejects(
    () => service.pinAgent({ source: "runner-global", refId: item!.refId, version: item!.version }, pinEnvironment({ runnerRowId: "runner-1" })),
    { code: "NOT_FOUND" },
  );
});

test("incompatible agents and missing models are rejected at pin; other runners' refs do not resolve", async () => {
  const { snapshots, views, directory, service, entry } = await agentFixture();
  snapshots.set(entry.sha256, agentFile("审查", "正文", "mode: subagent\n"));
  const accepted = await service.accept({
    ownerUserId: "owner-1",
    runnerRowId: "runner-1",
    entries: [entry],
    readSnapshot: (item2) => directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry: item2 }),
  });
  views.set("owner-1/runner-1", viewInput({ agents: accepted.agents }, [entry]));
  const bad = accepted.agents[0]!;
  assert.equal(bad.definition, null);
  await assert.rejects(
    () => service.pinAgent({ source: "runner-global", refId: bad.refId, version: bad.version }, pinEnvironment({ runnerRowId: "runner-1" })),
    { code: "CONFLICT" },
  );
  // 不显示为可执行：列表中携带不兼容原因。
  const listed = service.listAgents({ ownerUserId: "owner-1", runnerRowId: "runner-1", workspaceId: null, relativeCwd: null });
  assert.ok(listed[0]!.incompatibilities.length > 0);

  // modelId 必须在用户已有模型配置中可用。
  snapshots.set("a".repeat(64), agentFile("审查", "正文", "modelId: missing-model\n"));
  const withBadModel = await service.accept({
    ownerUserId: "owner-1",
    runnerRowId: "runner-1",
    entries: [{ ...entry, sha256: "a".repeat(64) }],
    readSnapshot: (item2) => directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry: item2 }),
  });
  views.set("owner-1/runner-1", viewInput({ agents: withBadModel.agents }, [{ ...entry, sha256: "a".repeat(64) }]));
  await assert.rejects(
    () =>
      service.pinAgent(
        { source: "runner-global", refId: withBadModel.agents[0]!.refId, version: withBadModel.agents[0]!.version },
        pinEnvironment({ runnerRowId: "runner-1" }),
      ),
    /model unavailable/,
  );

  // 跨 Runner 不串用：同 refId 在别的 Runner 视图不存在时 NOT_FOUND。
  await assert.rejects(
    () => service.pinAgent({ source: "runner-global", refId: bad.refId, version: bad.version }, pinEnvironment({ runnerRowId: "runner-2" })),
    { code: "NOT_FOUND" },
  );
});
