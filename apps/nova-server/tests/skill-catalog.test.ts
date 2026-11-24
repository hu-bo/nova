import assert from "node:assert/strict";
import test from "node:test";
import { careerCoachSkill, skillsCreaterSkill, specSkill } from "@nova/tools/harness";
import { listSkillCatalog, type CatalogSource } from "../src/modules/skills/skill-catalog.js";
import { localEntryKey, SkillService } from "../src/modules/skills/skill.service.js";
import type { LocalCatalogEntry, LocalCatalogView } from "../src/modules/skills/skill-directory.js";
import { fakeDirectory, pinEnvironment, repository, skillFile, viewInput } from "./skill-fakes.js";

function entry(overrides: Partial<LocalCatalogEntry> & { name: string; sha256: string }): LocalCatalogEntry {
  return {
    kind: "skill",
    scope: "global",
    workspaceId: "",
    relativeDir: "",
    description: "d",
    sizeBytes: 10,
    ...overrides,
  };
}

const catalogEnvironment = pinEnvironment({ runnerRowId: "runner-1", workspaceId: "ws-1", relativeCwd: "apps/api" });

async function fixture() {
  const repo = repository();
  const views = new Map<string, LocalCatalogView>();
  const snapshots = new Map<string, string>();
  const directory = fakeDirectory(views, snapshots);
  const service = new SkillService(repo, directory, { storageConfigured: true });
  const catalog: CatalogSource = { repository: repo, directory };
  return { repo, views, snapshots, directory, service, catalog };
}

test("directory merges builtin, platform and local sources with shadowing and status", async () => {
  const { repo, views, snapshots, service, catalog } = await fixture();
  // 内置：登记 career-coach 与 skills-creater；场景内置 nova.spec 不进目录。
  await service.registerBuiltins();
  // 平台：一个已发布技能。
  const platform = await service.createPlatform("owner-1", { body: skillFile("platform-skill", "平台技能") });
  await service.publish("owner-1", platform.id, { expectedRevision: 1, version: "1.0.0" });
  // 本地：同名全局 + 项目条目 -> 项目遮蔽全局；其它项目目录不混入。
  const globalAlpha = entry({ name: "review", sha256: "g".repeat(64) });
  const projectAlpha = entry({ name: "review", scope: "project", workspaceId: "ws-1", relativeDir: "apps/api", sha256: "p".repeat(64) });
  const otherProject = entry({ name: "elsewhere", scope: "project", workspaceId: "ws-1", relativeDir: "apps/web", sha256: "o".repeat(64) });
  snapshots.set(globalAlpha.sha256, skillFile("review", "全局审查"));
  snapshots.set(projectAlpha.sha256, skillFile("review", "项目审查"));
  snapshots.set(otherProject.sha256, skillFile("elsewhere", "其它目录"));
  await service.accept({
    ownerUserId: "owner-1",
    runnerRowId: "runner-1",
    entries: [globalAlpha, projectAlpha, otherProject],
    readSnapshot: (item) => directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId: "runner-1", entry: item }),
  });
  views.set("owner-1/runner-1", viewInput({ revision: 7 }, [globalAlpha, projectAlpha, otherProject]));

  const result = await listSkillCatalog(catalog, catalogEnvironment, { limit: 50 });
  const byId = new Map(result.items.map((item) => [item.id, item]));
  assert.ok(result.items.some((item) => item.id === "nova.career-coach" && item.source === "builtin"));
  assert.ok(result.items.some((item) => item.id === "nova.skills-creater" && item.source === "builtin"));
  assert.ok(!result.items.some((item) => item.id === specSkill.id), "场景内置不进目录");
  assert.ok(byId.has(platform.id));

  const locals = result.items.filter((item) => item.source === "runner-global" || item.source === "runner-project");
  assert.equal(locals.length, 2, "仅当前项目层 + 全局层可见");
  const globalItem = locals.find((item) => item.source === "runner-global");
  const projectItem = locals.find((item) => item.source === "runner-project");
  assert.ok(globalItem && projectItem);
  assert.equal(globalItem!.shadowedBy?.source, "runner-project", "被同名项目技能遮蔽的全局项仍返回并标注");
  assert.equal(result.catalog?.status, "ready");
  assert.equal(result.catalog?.revision, 7);

  // source 过滤 + q 过滤。
  const onlyGlobal = await listSkillCatalog(catalog, catalogEnvironment, { limit: 50, source: "runner-global" });
  assert.ok(onlyGlobal.items.every((item) => item.source === "runner-global"));
  const search = await listSkillCatalog(catalog, catalogEnvironment, { limit: 50, q: "求职" });
  assert.deepEqual(search.items.map((item) => item.id), ["nova.career-coach"]);

  // 无 Runner 环境（页面默认）：只有内置 + 平台，没有本地项。
  const page = await listSkillCatalog(catalog, pinEnvironment({ runnerRowId: null, workspaceId: null }), { limit: 50 });
  assert.ok(page.items.every((item) => item.source === "builtin" || item.source === "platform"));
  assert.equal(page.catalog, null);

  // 离线 Runner：本地项带 runner_offline 原因，不当作“没有技能”。
  views.set("owner-1/runner-1", viewInput({ status: "offline", online: false }, [globalAlpha, projectAlpha]));
  const offline = await listSkillCatalog(catalog, catalogEnvironment, { limit: 50 });
  const offlineLocal = offline.items.filter((item) => item.source.startsWith("runner-"));
  assert.ok(offlineLocal.length > 0);
  assert.ok(offlineLocal.every((item) => item.applicability.reasons.some((reason) => reason.code === "runner_offline")));

  // 过期目录：新选择标注需要重新核实。
  views.set("owner-1/runner-1", viewInput({ status: "stale" }, [globalAlpha, projectAlpha]));
  const stale = await listSkillCatalog(catalog, catalogEnvironment, { limit: 50, source: "runner-project" });
  assert.ok(stale.items[0]!.applicability.reasons.some((reason) => reason.code === "catalog_incomplete"));
  void repo;
});

test("plan mode marks workspace/tool skills unavailable in the directory", async () => {
  const { snapshots, views, service, directory, catalog } = await fixture();
  const body = "---\nname: builder\ndescription: 构建\nnova:\n  allowedModes: [build, auto]\n  requiredTools: [bash]\n---\n\n正文\n";
  const created = await service.createPlatform("owner-1", { body });
  await service.publish("owner-1", created.id, { expectedRevision: 1, version: "1.0.0" });
  const result = await listSkillCatalog(catalog, pinEnvironment({ mode: "plan" }), { limit: 50, source: "platform" });
  const item = result.items.find((entryItem) => entryItem.id === created.id);
  assert.ok(item);
  assert.equal(item!.applicability.status, "unavailable");
  assert.ok(item!.applicability.reasons.some((reason) => reason.code === "mode_not_allowed"));
  void snapshots;
  void views;
  void directory;
});

test("local identity comes from (owner, runner, scope, workspace, cwd, name) - two runners do not share", async () => {
  const { snapshots, views, service, directory, catalog } = await fixture();
  const body = skillFile("same-name", "同名技能");
  const sha = "d".repeat(64);
  snapshots.set(sha, body);
  const readSnapshot = (runnerRowId: string) => (item: LocalCatalogEntry) =>
    directory.readEntrySnapshot({ ownerUserId: "owner-1", runnerRowId, entry: item });
  const entryGlobal = entry({ name: "same-name", sha256: sha });
  await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-1", entries: [entryGlobal], readSnapshot: readSnapshot("runner-1") });
  await service.accept({ ownerUserId: "owner-1", runnerRowId: "runner-2", entries: [entryGlobal], readSnapshot: readSnapshot("runner-2") });
  views.set("owner-1/runner-1", viewInput({}, [entryGlobal]));
  views.set("owner-1/runner-2", viewInput({}, [entryGlobal]));
  const first = await listSkillCatalog(catalog, pinEnvironment({ runnerRowId: "runner-1" }), { limit: 50, source: "runner-global" });
  const second = await listSkillCatalog(catalog, pinEnvironment({ runnerRowId: "runner-2" }), { limit: 50, source: "runner-global" });
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0]!.id, second.items[0]!.id, "两个 Runner 的同名全局技能不是同一资源");
  assert.equal(localEntryKey(entryGlobal), "global|||same-name");
});
