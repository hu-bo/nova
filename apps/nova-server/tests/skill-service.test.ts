import assert from "node:assert/strict";
import test from "node:test";
import type { SkillSelection } from "@nova/agent-ui-contracts";
import { localEntryKey, SkillService } from "../src/modules/skills/skill.service.js";
import { fakeDirectory, pinEnvironment, repository, skillFile, viewInput } from "./skill-fakes.js";
import type { LocalCatalogEntry, LocalCatalogView } from "../src/modules/skills/skill-directory.js";

const globalAlphaKey = localEntryKey({ scope: "global", workspaceId: "", relativeDir: "", name: "alpha" });
const globalBrokenKey = localEntryKey({ scope: "global", workspaceId: "", relativeDir: "", name: "broken" });

// ---------- P0-C2 平台草稿与版本管理 ----------

test("platform draft lifecycle: create, save with revision guard, publish idempotently, disable", async () => {
  const service = new SkillService(repository(), fakeDirectory(new Map()), { storageConfigured: true });
  const created = await service.createPlatform("owner-1", { body: skillFile("test-report", "生成测试报告") });
  assert.equal(created.slug, "test-report");
  assert.equal(created.draftRevision, 1);
  assert.equal(created.currentPublished, null);

  const saved = await service.updateDraft("owner-1", created.id, { expectedRevision: 1, body: skillFile("renamed", "改名") });
  assert.equal(saved.draftRevision, 2);
  assert.equal(saved.slug, "renamed");
  // 并发覆盖防护：expectedRevision 过期直接 409。
  await assert.rejects(
    () => service.updateDraft("owner-1", created.id, { expectedRevision: 1, body: skillFile("stale", "过期") }),
    { code: "CONFLICT" },
  );

  const published = await service.publish("owner-1", created.id, { expectedRevision: 2, version: "1.0.0" });
  assert.equal(published.version, "1.0.0");
  // 相同版本同内容幂等返回原版本。
  const again = await service.publish("owner-1", created.id, { expectedRevision: 2, version: "1.0.0" });
  assert.equal(again.id, published.id);
  // 相同版本不同内容 409。
  await service.updateDraft("owner-1", created.id, { expectedRevision: 2, body: skillFile("renamed", "改名", "不同的正文") });
  await assert.rejects(() => service.publish("owner-1", created.id, { expectedRevision: 3, version: "1.0.0" }), {
    code: "CONFLICT",
  });

  const detail = await service.getVersionDetail("owner-1", created.id, "1.0.0");
  assert.match(detail.body, /name: renamed/);
  assert.deepEqual(detail.resources, []);

  const pinned = await service.pinForQueueing({ id: created.id, version: "1.0.0" }, pinEnvironment());
  assert.equal(pinned.source, "platform");
  const disabledView = await service.disable("owner-1", created.id);
  assert.equal(disabledView.disabled, true);
  // 停用拒绝新的选择（§6 末段）。
  await assert.rejects(() => service.pinForQueueing({ id: created.id, version: "1.0.0" }, pinEnvironment()), {
    code: "CONFLICT",
  });
});

test("explicit publish requirements must match the body nova field (single source)", async () => {
  const service = new SkillService(repository(), fakeDirectory(new Map()), { storageConfigured: true });
  const body = "---\nname: r\ndescription: d\nnova:\n  allowedModes: [build]\n---\n\n正文\n";
  await assert.rejects(
    () =>
      service.createPlatform("owner-1", {
        body,
        requirements: { allowedModes: ["plan", "build", "auto"], requiredTools: [], requiresWorkspace: false, requiresPublishing: false },
      }),
    { code: "VALIDATION_ERROR" },
  );
  const created = await service.createPlatform("owner-1", {
    body,
    requirements: { allowedModes: ["build"], requiredTools: [], requiresWorkspace: false, requiresPublishing: false },
  });
  assert.deepEqual(created.draft?.requirements.allowedModes, ["build"]);
});

test("cross-owner access returns NOT_FOUND, platform skill of other project is out_of_scope", async () => {
  const service = new SkillService(repository(), fakeDirectory(new Map()), { storageConfigured: true });
  const created = await service.createPlatform("owner-1", { body: skillFile("mine", "我的") });
  await assert.rejects(() => service.getPlatform("owner-2", created.id), { code: "NOT_FOUND" });
  await assert.rejects(
    () => service.pinForQueueing({ id: created.id, version: "1.0.0" }, pinEnvironment({ ownerUserId: "owner-2" })),
    { code: "NOT_FOUND" },
  );
  const scoped = await service.createPlatform("owner-1", { projectId: "project-a", body: skillFile("scoped", "项目技能") });
  await service.publish("owner-1", scoped.id, { expectedRevision: 1, version: "1.0.0" });
  await assert.rejects(
    () => service.pinForQueueing({ id: scoped.id, version: "1.0.0" }, pinEnvironment({ projectId: "project-b" })),
    { code: "CONFLICT", message: /其它项目/ },
  );
  const usable = await service.pinForQueueing({ id: scoped.id, version: "1.0.0" }, pinEnvironment({ projectId: "project-a" }));
  const afterPublish = await service.getPlatform("owner-1", scoped.id);
  assert.equal(usable.versionId, afterPublish.currentPublished?.id);
});

// ---------- P0-E2 本地摘要 → 版本映射 ----------

test("local catalog ingestion maps digests to 0.0.<revision>, reuses rows for the same digest", async () => {
  const repo = repository();
  const views = new Map<string, LocalCatalogView>();
  const snapshots = new Map<string, string>();
  const directory = fakeDirectory(views, snapshots);
  const service = new SkillService(repo, directory, { storageConfigured: true });
  const readSnapshot = (entry: LocalCatalogEntry) =>
    directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry });
  const bodyA = skillFile("alpha", "A 技能");
  const shaA = "a".repeat(64);
  snapshots.set(shaA, bodyA);
  const entryA: LocalCatalogEntry = {
    kind: "skill",
    scope: "global",
    workspaceId: "",
    relativeDir: "",
    name: "alpha",
    description: "A 技能",
    sha256: shaA,
    sizeBytes: bodyA.length,
  };
  const accepted = (await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-1", entries: [entryA], readSnapshot })).skills;
  const first = accepted.get(globalAlphaKey);
  assert.ok(first && first.status === "ready" && first.version === "0.0.1");

  // 同摘要再接受：复用版本行，不新建。
  const acceptedAgain = (
    await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-1", entries: [entryA], readSnapshot })
  ).skills;
  const again = acceptedAgain.get(globalAlphaKey);
  assert.ok(first && again && again.status === "ready" && again.versionId === first.versionId);

  // 磁盘编辑后新摘要形成新快照版本 0.0.2；已接受版本不受影响（红线 4）。
  const bodyB = skillFile("alpha", "A 技能", "改进后的方法");
  const shaB = "b".repeat(64);
  snapshots.set(shaB, bodyB);
  const acceptedB = (
    await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-1", entries: [{ ...entryA, sha256: shaB }], readSnapshot })
  ).skills;
  const second = acceptedB.get(globalAlphaKey);
  assert.ok(first && second && second.status === "ready" && second.version === "0.0.2" && second.versionId !== first.versionId);

  // 摘要不符（快照读取失败）如实记录问题，不伪造成功。
  const missing: LocalCatalogEntry = { ...entryA, name: "broken", sha256: "c".repeat(64) };
  const acceptedBroken = (
    await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-1", entries: [missing], readSnapshot })
  ).skills;
  const broken = acceptedBroken.get(globalBrokenKey);
  assert.ok(broken && broken.status === "failed");

  // 入队固定引用后，目录更新不影响已入队引用：pinForQueueing 走版本行；
  // 新选择要求当前目录摘要与快照一致（§4.3 末段）。
  views.set("owner-1/runner-1", viewInput({}, [{ ...entryA, sha256: shaA }]));
  const row = repo.rows.find((item) => item.slug === "alpha" && item.source === "runner-global");
  assert.ok(row);
  const pinned = await service.pinForQueueing({ id: row.id, version: "0.0.1" }, pinEnvironment({ runnerRowId: "runner-1" }));
  assert.equal(pinned.source, "runner-global");
  assert.match(pinned.runtimeId ?? "", /^skill\./);
  views.set("owner-1/runner-1", viewInput({}, [{ ...entryA, sha256: shaB }]));
  await assert.rejects(
    () => service.pinForQueueing({ id: row.id, version: "0.0.1" }, pinEnvironment({ runnerRowId: "runner-1" })),
    (error: { message: string }) => /刷新|变化/.test(error.message),
  );
});

// ---------- P0-F1/F5 入队准入 ----------

test("admission rejects write-requiring skills in plan mode and honors tool/storage/budget gates", async () => {
  const service = new SkillService(repository(), fakeDirectory(new Map()), { storageConfigured: false });
  const body =
    "---\nname: builder\ndescription: 构建\nnova:\n  allowedModes: [build, auto]\n  requiredTools: [bash]\n  requiresWorkspace: true\n  requiresPublishing: true\n---\n\n正文\n";
  const created = await service.createPlatform("owner-1", { body });
  await service.publish("owner-1", created.id, { expectedRevision: 1, version: "1.0.0" });
  const selection: SkillSelection = { id: created.id, version: "1.0.0" };

  await assert.rejects(
    () =>
      service.pinForQueueing(
        selection,
        pinEnvironment({ mode: "plan", storageConfigured: false, hostToolNames: new Set(["read_file"]) }),
      ),
    (error: { message: string; details?: unknown }) =>
      typeof error.message === "string" &&
      JSON.stringify(error.details).includes("mode_not_allowed") &&
      JSON.stringify(error.details).includes("tools_unavailable") &&
      JSON.stringify(error.details).includes("storage_unavailable"),
  );
  const ok = await service.pinForQueueing(selection, pinEnvironment({ mode: "build", storageConfigured: true }));
  assert.equal(ok.slug, "builder");
  // 无工作区：需要工作区的技能被拒（§3 第 3 条）。
  await assert.rejects(() => service.pinForQueueing(selection, pinEnvironment({ hasWorkspace: false })), { code: "CONFLICT" });
  // 40,000 字符预算：与场景内置 spec 一起超限时返回明确原因，不静默截断（§6）。
  const hugeBody = skillFile("huge", "大技能", "内".repeat(39_900));
  const huge = await service.createPlatform("owner-1", { body: hugeBody });
  await service.publish("owner-1", huge.id, { expectedRevision: 1, version: "1.0.0" });
  await assert.rejects(
    () => service.pinForQueueing({ id: huge.id, version: "1.0.0" }, pinEnvironment({ specSession: true })),
    (error: { details?: unknown }) => JSON.stringify(error.details).includes("budget_exceeded"),
  );
});
