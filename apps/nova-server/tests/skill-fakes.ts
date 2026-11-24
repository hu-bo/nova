import assert from "node:assert/strict";
import type { SkillSource } from "@nova/agent-ui-contracts";
import { DEFAULT_REQUIREMENTS } from "../src/modules/skills/index.js";
import type { LocalCatalogEntry, LocalCatalogView, SkillDirectoryPort } from "../src/modules/skills/skill-directory.js";
import type { SkillRepository as Repo } from "../src/modules/skills/skill.repository.js";
import type { SkillRow } from "../database/schema/skill.table.js";
import type { SkillVersionRow } from "../database/schema/skill-version.table.js";

/**
 * skills 测试替身：内存实现 SkillRepository/SkillDirectoryPort 的查询语义，
 * 供服务、目录与 Agent 测试共用（真实 DB/Runner 行为由集成测试覆盖）。
 */

export type Row = SkillRow;
export type VersionRow = SkillVersionRow;

let idCounter = 0;
export const nextId = (prefix: string) => `${prefix}-${(idCounter += 1)}`;

export function skillRow(partial: Partial<Row> & { source: SkillSource; slug: string }): Row {
  return {
    id: partial.id ?? nextId("skill"),
    source: partial.source,
    ownerUserId: partial.ownerUserId !== undefined ? partial.ownerUserId : "owner-1",
    projectId: partial.projectId ?? null,
    runnerId: partial.runnerId ?? null,
    workspaceId: partial.workspaceId ?? null,
    relativeCwd: partial.relativeCwd ?? null,
    slug: partial.slug,
    displayName: partial.displayName ?? null,
    description: partial.description ?? "",
    draftBody: partial.draftBody ?? null,
    draftRequirements: partial.draftRequirements ?? null,
    draftRevision: partial.draftRevision ?? 1,
    currentPublishedVersionId: partial.currentPublishedVersionId ?? null,
    disabled: partial.disabled ?? false,
    createdAt: partial.createdAt ?? new Date(0),
    updatedAt: partial.updatedAt ?? new Date(0),
  };
}

export function versionRow(
  partial: Partial<VersionRow> & { skillId: string; version: string; body: string; sha256: string },
): VersionRow {
  return {
    id: partial.id ?? nextId("version"),
    skillId: partial.skillId,
    version: partial.version,
    body: partial.body,
    slug: partial.slug ?? "s",
    description: partial.description ?? "d",
    displayName: partial.displayName ?? null,
    requirements: partial.requirements ?? DEFAULT_REQUIREMENTS,
    sha256: partial.sha256,
    sourceSha256: partial.sourceSha256 ?? null,
    resources: partial.resources ?? null,
    createdAt: partial.createdAt ?? new Date((idCounter += 1) * 1000),
  };
}

export class FakeRepository {
  rows: Row[] = [];
  versions: VersionRow[] = [];

  async findRowById(id: string) {
    return this.rows.find((row) => row.id === id);
  }
  async findOwnedRow(id: string, ownerUserId: string) {
    return this.rows.find((row) => row.id === id && row.ownerUserId === ownerUserId);
  }
  async findBuiltinBySlug(slug: string) {
    return this.rows.find((row) => row.source === "builtin" && row.slug === slug);
  }
  async listBuiltins() {
    return this.rows.filter((row) => row.source === "builtin");
  }
  async listPlatform(
    ownerUserId: string,
    filters: { projectId?: string | null; q?: string; limit: number; cursor?: { updatedAt: Date; id: string } },
  ) {
    return this.rows
      .filter((row) => row.source === "platform" && row.ownerUserId === ownerUserId)
      .slice(0, filters.limit + 1);
  }
  async findLocalIdentity(input: {
    ownerUserId: string;
    runnerId: string;
    source: string;
    workspaceId: string | null;
    relativeCwd: string | null;
    slug: string;
  }) {
    return this.rows.find(
      (row) =>
        row.ownerUserId === input.ownerUserId &&
        row.source === input.source &&
        row.runnerId === input.runnerId &&
        row.workspaceId === input.workspaceId &&
        row.relativeCwd === input.relativeCwd &&
        row.slug === input.slug,
    );
  }
  async insertLocalIdentity(input: Parameters<FakeRepository["findLocalIdentity"]>[0] & { description: string }) {
    const existing = await this.findLocalIdentity(input);
    if (existing) return existing;
    const row = skillRow({
      source: input.source as SkillSource,
      slug: input.slug,
      ownerUserId: input.ownerUserId,
      runnerId: input.runnerId,
      workspaceId: input.workspaceId,
      relativeCwd: input.relativeCwd,
      description: input.description,
    });
    this.rows.push(row);
    return row;
  }
  async listAllLocalByRunner(ownerUserId: string, runnerRowId: string) {
    return this.rows.filter((row) => row.ownerUserId === ownerUserId && row.runnerId === runnerRowId);
  }
  async insertPlatformSkill(input: {
    ownerUserId: string;
    projectId: string | null;
    slug: string;
    displayName: string | null;
    description: string;
    draftBody: string;
    draftRequirements: unknown;
  }) {
    const row = skillRow({
      source: "platform",
      slug: input.slug,
      ownerUserId: input.ownerUserId,
      projectId: input.projectId,
      displayName: input.displayName,
      description: input.description,
      draftBody: input.draftBody,
      draftRequirements: input.draftRequirements as never,
    });
    this.rows.push(row);
    return row;
  }
  async updateDraft(
    skillId: string,
    ownerUserId: string,
    expectedRevision: number,
    patch: { draftBody: string; slug: string; description: string; requirements: unknown },
  ) {
    const row = this.rows.find(
      (item) => item.id === skillId && item.ownerUserId === ownerUserId && item.draftRevision === expectedRevision,
    );
    if (!row) return undefined;
    Object.assign(row, {
      draftBody: patch.draftBody,
      slug: patch.slug,
      description: patch.description,
      draftRequirements: patch.requirements,
      draftRevision: row.draftRevision + 1,
    });
    return row;
  }
  async disableSkill(skillId: string, ownerUserId: string) {
    const row = this.rows.find((item) => item.id === skillId && item.ownerUserId === ownerUserId);
    if (!row) return undefined;
    row.disabled = true;
    return row;
  }
  async setCurrentPublishedVersion(skillId: string, versionId: string) {
    const row = this.rows.find((item) => item.id === skillId);
    if (row) row.currentPublishedVersionId = versionId;
  }
  async insertBuiltinSkill(input: { slug: string; displayName: string | null; description: string }) {
    const existing = await this.findBuiltinBySlug(input.slug);
    if (existing) return existing;
    const row = skillRow({
      source: "builtin",
      slug: input.slug,
      ownerUserId: null,
      displayName: input.displayName,
      description: input.description,
    });
    this.rows.push(row);
    return row;
  }
  async findVersion(skillId: string, version: string) {
    return this.versions.find((item) => item.skillId === skillId && item.version === version);
  }
  async findVersionById(versionId: string) {
    return this.versions.find((item) => item.id === versionId);
  }
  async findVersionBySha(skillId: string, sha256: string) {
    return this.versions.find((item) => item.skillId === skillId && item.sha256 === sha256);
  }
  async findVersionBySourceSha(skillId: string, sourceSha256: string) {
    return this.versions.find((item) => item.skillId === skillId && item.sourceSha256 === sourceSha256);
  }
  async countVersions(skillId: string) {
    return this.versions.filter((item) => item.skillId === skillId).length;
  }
  async insertVersion(
    input: Partial<VersionRow> & { skillId: string; version: string; body: string; sha256: string },
  ) {
    const existing = await this.findVersion(input.skillId, input.version);
    if (existing) return existing;
    const row = versionRow(input);
    this.versions.push(row);
    return row;
  }
  async listVersions(skillId: string, filters: { limit: number; cursor?: Date }) {
    return this.versions
      .filter((item) => item.skillId === skillId && (!filters.cursor || item.createdAt < filters.cursor))
      .slice(0, filters.limit + 1);
  }
  async listVersionsBySourceSha(pairs: readonly { skillId: string; sourceSha256: string }[]) {
    return this.versions.filter((item) =>
      pairs.some((pair) => pair.skillId === item.skillId && pair.sourceSha256 === item.sourceSha256),
    );
  }
}

export function repository() {
  return new FakeRepository() as unknown as Repo & FakeRepository;
}

export function viewInput(overrides: Partial<LocalCatalogView> = {}, entries: LocalCatalogEntry[] = []): LocalCatalogView {
  return {
    online: true,
    status: "ready",
    revision: 1,
    complete: true,
    diagnostics: [],
    entries,
    agents: [],
    writable: true,
    ...overrides,
  };
}

export function fakeDirectory(views: Map<string, LocalCatalogView>, snapshots: Map<string, string> = new Map()) {
  const port: SkillDirectoryPort = {
    view: (runnerRowId, ownerUserId) => views.get(`${ownerUserId}/${runnerRowId}`),
    refresh: async (input) => {
      const key = `${input.ownerUserId}/${input.runnerRowId}`;
      const view = views.get(key);
      if (!view) throw new Error("offline");
      const refreshed = viewInput({ ...view, revision: view.revision + 1 }, view.entries);
      views.set(key, refreshed);
      return refreshed;
    },
    readEntrySnapshot: async (input) => {
      const body = snapshots.get(input.entry.sha256);
      if (body === undefined) throw new Error(`snapshot digest mismatch for ${input.entry.name}`);
      return body;
    },
    writeResourceFile: async () => ({ sha256: "0".repeat(64), sizeBytes: 1, created: true }),
  };
  return port;
}

export const skillFile = (name: string, description = "说明", body = "正文方法。") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

export function pinEnvironment(overrides: Record<string, unknown> = {}) {
  return {
    mode: "build" as const,
    hasWorkspace: true,
    hostToolNames: new Set(["bash", "write_file", "read_file", "edit_file", "list_dir", "grep", "git_diff"]),
    storageConfigured: true,
    specSession: false,
    projectId: null,
    ownerUserId: "owner-1",
    runnerRowId: null,
    workspaceId: null,
    relativeCwd: null,
    ...overrides,
  };
}

export function expectReady(entry: unknown): asserts entry is { status: "ready"; version: string; versionId: string } {
  assert.deepEqual((entry as { status: string }).status, "ready");
}
