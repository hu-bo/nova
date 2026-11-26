import type { RunnerIdentity } from "./types.js";

/**
 * 本地受限资源（docs/design/nova-skills.md §4.3）的共享类型与线格式转换。
 * 诊断 code 枚举镜像 `@nova/agent-ui-contracts` 的 `skillCatalogDiagnosticSchema`
 * （不引入包依赖；服务端 E 组负责映射到 UI 契约）。
 */

export type LocalResourceKind = "skill" | "agent";
export type LocalResourceScope = "global" | "project";

export type ResourceCatalogDiagnosticCode =
  | "missing_home"
  | "permission_denied"
  | "invalid_frontmatter"
  | "file_too_large"
  | "duplicate_name"
  | "path_escape"
  | "truncated"
  | "scan_timeout"
  | "scan_error";

export interface ResourceCatalogEntry {
  readonly kind: LocalResourceKind;
  readonly scope: LocalResourceScope;
  /** global 时为空；project 时为注册工作区 ID。 */
  readonly workspaceId: string;
  /** project：相对注册工作区根的目录标识（根为 "."）；global 为空。 */
  readonly relativeDir: string;
  readonly name: string;
  readonly description: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ResourceCatalogDiagnostic {
  readonly code: ResourceCatalogDiagnosticCode;
  readonly message: string;
  readonly name: string;
  /** 只允许相对源根的路径。 */
  readonly path: string;
}

export interface ResourceCatalogPublished {
  readonly catalogRevision: number;
  /** 对定向刷新的应答回带；自发发布为空串。 */
  readonly refreshId: string;
  /** false = 扫描被截断或部分失败；不得当作「用户没有技能」。 */
  readonly complete: boolean;
  readonly entries: readonly ResourceCatalogEntry[];
  readonly diagnostics: readonly ResourceCatalogDiagnostic[];
}

export interface ResourceSnapshot {
  readonly contents: Uint8Array;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ResourceSnapshotRequest {
  readonly kind: LocalResourceKind;
  readonly scope: LocalResourceScope;
  /** scope=project 时必填（注册工作区 ID）；scope=global 时必须省略或为空。 */
  readonly workspaceId?: string;
  /** scope=project 时的项目层目录标识（默认 "." = 工作区根）。 */
  readonly relativeDir?: string;
  readonly name: string;
  /** P0 只允许入口路径；留空由 Runner 按 kind+name 推导。 */
  readonly relativePath?: string;
  /** 必填：目录发布时的入口摘要；不符时 Runner 返回 CONFLICT（不返回新内容）。 */
  readonly expectedSha256: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ResourceWriteRequest {
  readonly kind: LocalResourceKind;
  readonly scope: LocalResourceScope;
  readonly workspaceId?: string;
  readonly relativeDir?: string;
  readonly name: string;
  readonly relativePath?: string;
  readonly contents: Uint8Array;
  /** 空 = 仅创建且目标必须不存在；非空 = CAS。 */
  readonly expectedSha256?: string;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface ResourceWriteResult {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly created: boolean;
}

export interface ResourceRefreshRequest {
  readonly scope: LocalResourceScope;
  readonly workspaceId?: string;
  readonly relativeDir?: string;
  /** 关联 ID（应答的 ResourceCatalogPublished 原样回带）；缺省自动生成。 */
  readonly refreshId?: string;
}

/** 「能力不支持」与传输/业务错误必须可区分（旧 Runner 未声明发现能力）。 */
export const CAPABILITY_UNSUPPORTED = "CAPABILITY_UNSUPPORTED";
/** 与 crates/runner/src/main.rs 上报的 hello.capabilities 字符串一致。 */
export const LOCAL_RESOURCES_CAPABILITY = "local_resources";
export const LOCAL_RESOURCES_WRITE_CAPABILITY = "local_resources.write";
/** Runner 入口文件大小上限（与 crates/runner local_resources::MAX_ENTRY_BYTES 一致）。 */
export const MAX_RESOURCE_ENTRY_BYTES = 256 * 1024;
/** 单次 DeleteWorkspacePaths 批量上限（与 crates/runner engine::MAX_DELETE_PATHS 一致）。 */
export const MAX_DELETE_PATHS = 64;

export function supportsLocalResources(identity: RunnerIdentity): boolean {
  return identity.capabilities.includes(LOCAL_RESOURCES_CAPABILITY);
}

export function supportsLocalResourceWrites(identity: RunnerIdentity): boolean {
  return (
    supportsLocalResources(identity) &&
    identity.capabilities.includes(LOCAL_RESOURCES_WRITE_CAPABILITY)
  );
}

export function toWireKind(kind: LocalResourceKind): string {
  return kind === "skill" ? "RESOURCE_KIND_SKILL" : "RESOURCE_KIND_AGENT";
}

export function toWireScope(scope: LocalResourceScope): string {
  return scope === "global" ? "RESOURCE_SCOPE_GLOBAL" : "RESOURCE_SCOPE_PROJECT";
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const KEBAB_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 与 crates/runner normalize_relative_dir 同规则（posix，允许反斜杠输入）。 */
function isSafeRelativeDir(dir: string): boolean {
  if (dir === ".") return true;
  if (!dir || dir.includes("\0") || dir.startsWith("/")) return false;
  return dir.split(/[\\/]/).every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** 客户端侧预校验（Runner 仍是最终裁决者）：非法输入不发 RPC。 */
export function validateLocator(request: {
  scope: LocalResourceScope;
  workspaceId?: string | undefined;
  relativeDir?: string | undefined;
  name: string;
}): string | null {
  if (!KEBAB_RE.test(request.name) || request.name.length > 64)
    return "name must be lowercase kebab-case within 64 characters";
  if (request.scope === "global") {
    if (request.workspaceId || request.relativeDir)
      return "global resources must not carry workspaceId or relativeDir";
    return null;
  }
  if (!request.workspaceId) return "project resources require a registered workspaceId";
  if (!isSafeRelativeDir(request.relativeDir ?? "."))
    return "relativeDir must be a workspace-relative path that stays inside the workspace";
  return null;
}

/**
 * 校验 DeleteWorkspacePaths 批量入参（与 crates/runner engine::delete_workspace_paths 同规则）：
 * 非空、不超过 MAX_DELETE_PATHS、每项工作区相对且不含 `..`、不得为工作区根 "."。
 * 返回错误原因或 null。
 */
export function validateDeletablePaths(relativePaths: readonly string[]): string | null {
  if (relativePaths.length === 0) return "relativePaths must not be empty";
  if (relativePaths.length > MAX_DELETE_PATHS)
    return `relativePaths is limited to ${MAX_DELETE_PATHS} entries per request`;
  for (const raw of relativePaths) {
    if (raw === ".") return "the workspace root itself cannot be deleted";
    if (!isSafeRelativeDir(raw))
      return `relativePath must be a workspace-relative path that stays inside the workspace: ${JSON.stringify(raw)}`;
  }
  return null;
}

/** 解析 ResourceCatalogPublished 线帧为强类型；结构非法时抛错（调用方决定降级策略）。 */
export function parseResourceCatalog(value: Record<string, unknown>): ResourceCatalogPublished {
  const catalogRevision = numberField(value.catalogRevision, "catalog_revision");
  const refreshId = stringOr(value.refreshId, "");
  const complete = value.complete === true;
  const rawEntries = Array.isArray(value.entries) ? value.entries : [];
  const entries: ResourceCatalogEntry[] = [];
  for (const item of rawEntries) {
    if (typeof item !== "object" || item === null) throw new TypeError("catalog entry is not a record");
    const entry = item as Record<string, unknown>;
    const kind = enumName(entry.kind);
    const scope = enumName(entry.scope);
    if (kind !== "RESOURCE_KIND_SKILL" && kind !== "RESOURCE_KIND_AGENT")
      throw new TypeError(`unknown resource kind: ${String(entry.kind)}`);
    if (scope !== "RESOURCE_SCOPE_GLOBAL" && scope !== "RESOURCE_SCOPE_PROJECT")
      throw new TypeError(`unknown resource scope: ${String(entry.scope)}`);
    const sha256 = stringOr(entry.sha256, "");
    if (!SHA256_RE.test(sha256)) throw new TypeError("catalog entry digest is malformed");
    const name = stringOr(entry.name, "");
    if (!KEBAB_RE.test(name)) throw new TypeError("catalog entry name is malformed");
    entries.push({
      kind: kind === "RESOURCE_KIND_SKILL" ? "skill" : "agent",
      scope: scope === "RESOURCE_SCOPE_GLOBAL" ? "global" : "project",
      workspaceId: stringOr(entry.workspaceId, ""),
      relativeDir: stringOr(entry.relativeDir, ""),
      name,
      description: stringOr(entry.description, ""),
      sha256,
      sizeBytes: numberField(entry.sizeBytes, "size_bytes"),
    });
  }
  const rawDiagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : [];
  const diagnostics: ResourceCatalogDiagnostic[] = rawDiagnostics.map((item) => {
    if (typeof item !== "object" || item === null) throw new TypeError("catalog diagnostic is not a record");
    const diagnostic = item as Record<string, unknown>;
    const code = stringOr(diagnostic.code, "");
    if (!DIAGNOSTIC_CODES.has(code)) throw new TypeError(`unknown diagnostic code: ${code}`);
    const path = stringOr(diagnostic.path, "");
    if (path.includes(":") || path.startsWith("/") || path.split("/").includes(".."))
      throw new TypeError("diagnostic path must stay relative to the source root");
    return {
      code: code as ResourceCatalogDiagnosticCode,
      message: stringOr(diagnostic.message, ""),
      name: stringOr(diagnostic.name, ""),
      path,
    };
  });
  return { catalogRevision, refreshId, complete, entries, diagnostics };
}

const DIAGNOSTIC_CODES: ReadonlySet<string> = new Set<ResourceCatalogDiagnosticCode>([
  "missing_home",
  "permission_denied",
  "invalid_frontmatter",
  "file_too_large",
  "duplicate_name",
  "path_escape",
  "truncated",
  "scan_timeout",
  "scan_error",
]);

function enumName(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberField(value: unknown, field: string): number {
  const converted = typeof value === "string" ? Number(value) : Number(value ?? 0);
  if (!Number.isSafeInteger(converted) || converted < 0)
    throw new TypeError(`${field} exceeds JavaScript's safe integer range`);
  return converted;
}
