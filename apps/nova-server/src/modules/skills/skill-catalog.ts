import {
  type SkillCatalogDiagnostic,
  type SkillCatalogEntry,
  type SkillCatalogStatus,
  type SkillSource,
  type SkillUnavailability,
} from "@nova/agent-ui-contracts";
import { evaluateSkillApplicability } from "./skill-definition.js";
import {
  catalogEntryFromVersion,
  DEFAULT_REQUIREMENTS,
  localEntryKey,
  normalizeRelativeDir,
  SCENARIO_BUILTIN_RUNTIME_IDS,
  type SkillEnvironment,
} from "./skill.service.js";
import type { SkillRepository } from "./skill.repository.js";
import type { LocalCatalogEntry, LocalCatalogView, SkillDirectoryPort } from "./skill-directory.js";
import type { SkillRow } from "../../../database/schema/skill.table.js";
import type { SkillVersionRow } from "../../../database/schema/skill-version.table.js";

/**
 * 合并目录查询（docs/design/nova-skills.md §3.1、§8.2 GET /skills、P0-C4）。
 * 内置 + 平台 + 当前 Runner 全局层 + 会话/项目目录层（canonicalCwd 精确匹配，不向上继承）。
 * 只读：本函数不触发快照 RPC（快照在接受目录发布时已摄取，详情正文走版本详情接口）。
 * 分页游标只作用于平台来源；内置与本地条目数量有界，每页返回；客户端按隔离键缓存合并。
 */

export type SkillCatalogQuery = {
  source?: SkillSource | undefined;
  q?: string | undefined;
  cursor?: string | undefined;
  limit: number;
};

export type SkillCatalogResult = {
  items: SkillCatalogEntry[];
  nextCursor: string | null;
  /** 本地目录状态（查询覆盖 Runner 时返回）；与「用户没有技能」严格区分（P0-H5）。 */
  catalog: {
    runnerId: string;
    status: SkillCatalogStatus;
    revision: number;
    complete: boolean;
    diagnostics: SkillCatalogDiagnostic[];
  } | null;
};

export type CatalogSource = {
  repository: SkillRepository;
  directory: SkillDirectoryPort;
};

export async function listSkillCatalog(
  source: CatalogSource,
  environment: SkillEnvironment,
  query: SkillCatalogQuery,
): Promise<SkillCatalogResult> {
  const { repository, directory } = source;
  const items: SkillCatalogEntry[] = [];

  if (acceptsSource(query.source, "builtin")) {
    for (const row of await repository.listBuiltins()) {
      const runtimeId = `nova.${row.slug}`;
      if (SCENARIO_BUILTIN_RUNTIME_IDS.has(runtimeId)) continue;
      const version = row.currentPublishedVersionId ? await repository.findVersionById(row.currentPublishedVersionId) : undefined;
      if (version) items.push(builtinEntry(row, version, environment, runtimeId));
    }
  }

  let nextCursor: string | null = null;
  if (acceptsSource(query.source, "platform")) {
    const cursor = parseCursor(query.cursor);
    const rows = await repository.listPlatform(environment.ownerUserId, {
      limit: query.limit,
      ...(cursor ? { cursor } : {}),
      ...(query.q ? { q: query.q } : {}),
    });
    const page = rows.slice(0, query.limit);
    for (const row of page) {
      const version = row.currentPublishedVersionId ? await repository.findVersionById(row.currentPublishedVersionId) : undefined;
      items.push(platformEntry(row, version, environment));
    }
    if (rows.length > query.limit && page.length > 0) {
      const last = page.at(-1)!;
      nextCursor = `${last.updatedAt.toISOString()}|${last.id}`;
    }
  }

  const wantsLocal = query.source === undefined || query.source === "runner-global" || query.source === "runner-project";
  const view = wantsLocal && environment.runnerRowId ? directory.view(environment.runnerRowId, environment.ownerUserId) : undefined;
  if (view) items.push(...(await localEntries(source, environment, view, query)));

  return {
    items: applyShadowing(items).filter((item) => (query.source ? item.source === query.source : matchesQuery(item, query.q))),
    nextCursor,
    catalog: view ? catalogMeta(view, environment) : null,
  };
}

async function localEntries(
  source: CatalogSource,
  environment: SkillEnvironment,
  view: LocalCatalogView,
  query: SkillCatalogQuery,
): Promise<SkillCatalogEntry[]> {
  const rows = await source.repository.listAllLocalByRunner(environment.ownerUserId, environment.runnerRowId!);
  const rowByKey = new Map<string, SkillRow>();
  for (const row of rows) rowByKey.set(identityKeyFromRow(row), row);
  const relevant = view.entries.filter((entry) => {
    if (entry.kind !== "skill" || !matchesLayer(entry, environment)) return false;
    if (query.source === undefined) return true;
    return query.source === "runner-global" ? entry.scope === "global" : entry.scope === "project";
  });
  const pairs = relevant.flatMap((entry) => {
    const row = rowByKey.get(localEntryKey(entry));
    return row ? [{ skillId: row.id, sourceSha256: entry.sha256 }] : [];
  });
  const versions = await source.repository.listVersionsBySourceSha(pairs);
  const versionByKey = new Map(versions.map((version) => [`${version.skillId}|${version.sourceSha256}`, version]));
  const entries: SkillCatalogEntry[] = [];
  for (const item of relevant) {
    const row = rowByKey.get(localEntryKey(item));
    if (!row) {
      entries.push(pendingLocalEntry(item, environment));
      continue;
    }
    const version = versionByKey.get(`${row.id}|${item.sha256}`);
    if (version) {
      entries.push(localView(catalogEntryFromVersion(row, version, { status: "available", reasons: [] }), item, row, environment, view));
      continue;
    }
    // 摘要未登记（快照/解析失败或刚发布目录尚未完成接受）：显示为待核实，不冒充可选。
    const placeholder = catalogEntryFromVersion(row, placeholderVersion(row, item), {
      status: "unavailable",
      reasons: [{ code: "catalog_incomplete", message: "本地技能尚未完成快照登记，请刷新目录后重新核实" }],
    });
    entries.push(localView(placeholder, item, row, environment, view));
  }
  return entries;
}

function placeholderVersion(row: SkillRow, entry: LocalCatalogEntry): SkillVersionRow {
  const base = {
    id: "",
    skillId: row.id,
    version: "0.0.0",
    body: "",
    slug: entry.name,
    description: entry.description,
    displayName: row.displayName,
    requirements: DEFAULT_REQUIREMENTS,
    sha256: entry.sha256,
    sourceSha256: entry.sha256,
    resources: null,
    createdAt: new Date(0),
  };
  return base as SkillVersionRow;
}

function localView(
  entry: SkillCatalogEntry,
  catalogEntry: LocalCatalogEntry,
  row: SkillRow,
  environment: SkillEnvironment,
  view: LocalCatalogView,
): SkillCatalogEntry {
  const reasons: SkillUnavailability[] = [...viewReasons(view), ...entry.applicability.reasons];
  if (entry.applicability.status === "available")
    reasons.push(
      ...evaluateSkillApplicability(entry.requirements, {
        mode: environment.mode,
        hasWorkspace: environment.hasWorkspace,
        hostToolNames: environment.hostToolNames,
        storageConfigured: environment.storageConfigured,
      }).reasons,
    );
  const disabled = row.disabled;
  if (disabled) reasons.push({ code: "disabled", message: "技能已停用，不能新选择" });
  return {
    ...entry,
    source: row.source,
    runnerId: row.runnerId,
    workspaceId: row.workspaceId,
    cwd: row.relativeCwd,
    sha256: catalogEntry.sha256,
    disabled,
    applicability: { status: reasons.length === 0 ? "available" : "unavailable", reasons },
  };
}

function viewReasons(view: LocalCatalogView): SkillUnavailability[] {
  switch (view.status) {
    case "unsupported":
      return [{ code: "runner_unsupported", message: "该 Runner 未提供本地技能发现能力" }];
    case "offline":
      return [{ code: "runner_offline", message: "本地技能所属 Runner 当前离线" }];
    case "scanning":
      return [{ code: "catalog_incomplete", message: "本地目录扫描中，结果稍后更新" }];
    case "stale":
      return [{ code: "catalog_incomplete", message: "本地目录已过期，请刷新后重新核实" }];
    case "incomplete":
      return [{ code: "catalog_incomplete", message: "本地目录扫描不完整，请刷新后重新核实" }];
    case "ready":
      return view.complete ? [] : [{ code: "catalog_incomplete", message: "本地目录扫描不完整，请刷新后重新核实" }];
  }
}

function pendingLocalEntry(entry: LocalCatalogEntry, environment: SkillEnvironment): SkillCatalogEntry {
  return {
    id: `unregistered.${entry.name}`,
    version: "0.0.0",
    name: entry.name,
    description: entry.description,
    source: entry.scope === "global" ? "runner-global" : "runner-project",
    requirements: DEFAULT_REQUIREMENTS,
    projectId: null,
    runnerId: environment.runnerRowId,
    workspaceId: entry.scope === "project" ? entry.workspaceId : null,
    cwd: entry.scope === "project" ? normalizeRelativeDir(entry.relativeDir) : null,
    sha256: entry.sha256,
    applicability: {
      status: "unavailable",
      reasons: [{ code: "catalog_incomplete", message: "本地技能尚未完成快照登记，请刷新目录后重新核实" }],
    },
    disabled: false,
  };
}

/** 项目层按 canonicalCwd 目录精确匹配；不把整个 workspace 混给所有子项目（§4.3）。 */
function matchesLayer(entry: LocalCatalogEntry, environment: SkillEnvironment): boolean {
  if (entry.scope === "global") return true;
  return (
    entry.workspaceId === environment.workspaceId &&
    normalizeRelativeDir(entry.relativeDir) === normalizeRelativeDir(environment.relativeCwd)
  );
}

function identityKeyFromRow(row: SkillRow): string {
  return localEntryKey({
    scope: row.source === "runner-global" ? "global" : "project",
    workspaceId: row.workspaceId ?? "",
    relativeDir: row.relativeCwd ?? ".",
    name: row.slug,
  });
}

function builtinEntry(row: SkillRow, version: SkillVersionRow, environment: SkillEnvironment, runtimeId: string): SkillCatalogEntry {
  const reasons = evaluateSkillApplicability(version.requirements ?? DEFAULT_REQUIREMENTS, {
    mode: environment.mode,
    hasWorkspace: environment.hasWorkspace,
    hostToolNames: environment.hostToolNames,
    storageConfigured: environment.storageConfigured,
  }).reasons;
  return {
    ...catalogEntryFromVersion(row, version, { status: reasons.length === 0 ? "available" : "unavailable", reasons }),
    id: runtimeId,
  };
}

function platformEntry(row: SkillRow, version: SkillVersionRow | undefined, environment: SkillEnvironment): SkillCatalogEntry {
  const base: SkillCatalogEntry = version
    ? catalogEntryFromVersion(row, version, { status: "available", reasons: [] })
    : {
        id: row.id,
        version: "0.0.0",
        name: row.displayName ?? row.slug,
        description: row.description,
        source: "platform",
        requirements: row.draftRequirements ?? DEFAULT_REQUIREMENTS,
        projectId: row.projectId,
        runnerId: null,
        workspaceId: null,
        cwd: null,
        sha256: null,
        applicability: { status: "unavailable", reasons: [] },
        disabled: row.disabled,
      };
  const reasons = [...base.applicability.reasons];
  if (!version) reasons.push({ code: "version_unavailable", message: "技能尚未发布，不能选择" });
  if (row.projectId && row.projectId !== environment.projectId)
    reasons.push({ code: "out_of_scope", message: "技能绑定了其它项目，当前会话不可用" });
  if (row.disabled) reasons.push({ code: "disabled", message: "技能已停用，不能新选择" });
  reasons.push(
    ...evaluateSkillApplicability(base.requirements, {
      mode: environment.mode,
      hasWorkspace: environment.hasWorkspace,
      hostToolNames: environment.hostToolNames,
      storageConfigured: environment.storageConfigured,
    }).reasons,
  );
  return { ...base, applicability: { status: reasons.length === 0 ? "available" : "unavailable", reasons } };
}

/**
 * 同名覆盖展示（§4.3 身份与覆盖）：项目 > 当前 Runner 全局；被遮蔽的全局项仍返回并标注。
 * 内置以 `nova.*` 确切 ID 呈现，不参与磁盘 slug 覆盖判定（磁盘同名文件不替换内置）。
 */
function applyShadowing(items: SkillCatalogEntry[]): SkillCatalogEntry[] {
  const projectBySlug = new Set(
    items.filter((item) => item.source === "runner-project").map((item) => item.name.toLowerCase()),
  );
  if (projectBySlug.size === 0) return items;
  return items.map((item) => {
    if (item.source !== "runner-global" || !projectBySlug.has(item.name.toLowerCase())) return item;
    const shadow = items.find(
      (other) => other.source === "runner-project" && other.name.toLowerCase() === item.name.toLowerCase(),
    );
    return {
      ...item,
      shadowedBy: { name: item.name, source: "runner-project" as SkillSource, runnerId: shadow?.runnerId ?? item.runnerId, projectId: null },
    };
  });
}

function catalogMeta(view: LocalCatalogView, environment: SkillEnvironment): SkillCatalogResult["catalog"] {
  return {
    runnerId: environment.runnerRowId!,
    status: view.status,
    revision: view.revision,
    complete: view.complete,
    diagnostics: [...view.diagnostics],
  };
}

function acceptsSource(filter: SkillSource | undefined, candidate: SkillSource): boolean {
  return filter === undefined || filter === candidate;
}

function matchesQuery(item: SkillCatalogEntry, q?: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle);
}

function parseCursor(cursor: string | undefined): { updatedAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [date, id] = cursor.split("|");
  if (!date || !id) throw new Error("Invalid cursor");
  const updatedAt = new Date(date);
  if (Number.isNaN(updatedAt.getTime())) throw new Error("Invalid cursor");
  return { updatedAt, id };
}
