import type { RunnerFailure } from "@nova/runner-protocol";
import type {
  ResourceCatalogPublished,
  ResourceRefreshRequest,
  ResourceSnapshot,
  ResourceSnapshotRequest,
  ResourceWriteRequest,
  ResourceWriteResult,
} from "./resources.js";

export type {
  LocalResourceKind,
  LocalResourceScope,
  ResourceCatalogDiagnostic,
  ResourceCatalogDiagnosticCode,
  ResourceCatalogEntry,
  ResourceCatalogPublished,
  ResourceRefreshRequest,
  ResourceSnapshot,
  ResourceSnapshotRequest,
  ResourceWriteRequest,
  ResourceWriteResult,
} from "./resources.js";

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: RunnerFailure };

export interface RunnerIdentity {
  readonly runnerId: string;
  readonly bootId: string;
  readonly protocolVersion: number;
  readonly version: string;
  readonly platform: string;
  readonly workspaces: readonly {
    readonly workspaceId: string;
    readonly displayName: string;
    readonly permission: "READ_ONLY" | "READ_WRITE";
  }[];
  readonly capabilities: readonly string[];
  readonly maxConcurrency: number;
}

export interface RunnerSdkOptions {
  readonly server?: import("node:http").Server;
  readonly path?: string;
  readonly host?: string;
  readonly port?: number;
  readonly heartbeatIntervalMs?: number;
  readonly admissionTimeoutMs?: number;
  readonly onDiagnostic?: (diagnostic: { code: string }) => void;
}

export interface RunnerSessionCandidate {
  readonly identity: RunnerIdentity;
  readonly token: string;
  accept(options: { principalId: string }): Promise<RunnerSession>;
  reject(code: string, message: string): void;
}

export interface RunnerSdk {
  readonly endpoint: string;
  listen(): Promise<void>;
  onSession(listener: (candidate: RunnerSessionCandidate) => void | Promise<void>): () => void;
  close(): Promise<void>;
}

export interface RunnerSession {
  readonly identity: RunnerIdentity;
  readonly bootId: string;
  readonly connectionEpoch: string | null;
  readonly connected: boolean;
  readonly workspaces: RunnerIdentity["workspaces"];
  createToolContext(options: ToolContextOptions): ToolContext;
  onStatus(listener: () => void): () => void;
  cancel(operationId: string): Promise<Result<void>>;
  query(operationId: string): Promise<Result<unknown>>;
  /** 本地受限资源（§4.3）：能力位、目录接收、定向刷新、快照读取与受限写入。 */
  supportsLocalResources(): boolean;
  supportsLocalResourceWrites(): boolean;
  onResourceCatalog(listener: (catalog: ResourceCatalogPublished) => void): () => void;
  refreshResources(request: ResourceRefreshRequest): Promise<Result<void>>;
  readResourceSnapshot(request: ResourceSnapshotRequest): Promise<Result<ResourceSnapshot>>;
  writeResourceFile(request: ResourceWriteRequest): Promise<Result<ResourceWriteResult>>;
  deleteWorkspacePaths(options: WorkspacePathDeletionOptions): Promise<Result<WorkspacePathDeletionResult>>;
  close(): Promise<void>;
}

export interface TextFile {
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines?: number;
  readonly totalSize: number;
  readonly sha256: string;
  readonly truncated: boolean;
  readonly lineTruncated: boolean;
}

export interface DirectoryEntry {
  readonly path: string;
  readonly kind: "file" | "dir" | "symlink";
  readonly sizeBytes: number;
}

export interface SearchMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export interface ExecOutput {
  readonly operationId: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly truncated: boolean;
  readonly outputGap: boolean;
}

export interface OutputChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
}

export interface ExecOptions {
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly stdin?: Uint8Array | string;
  readonly onOutput?: (chunk: OutputChunk) => void;
  readonly signal?: AbortSignal;
}

export interface FileSystem {
  read(path: string, options?: { offset?: number; limit?: number; signal?: AbortSignal }): Promise<Result<TextFile>>;
  readBytes(path: string, options?: { signal?: AbortSignal }): Promise<Result<Uint8Array>>;
  list(path?: string, options?: { depth?: number; maxEntries?: number; signal?: AbortSignal }): Promise<Result<DirectoryEntry[]>>;
  grep(
    pattern: string,
    options?: { path?: string; glob?: string; maxResults?: number; signal?: AbortSignal },
  ): Promise<Result<{ matches: SearchMatch[]; truncated: boolean }>>;
  write(
    path: string,
    content: string,
    options?: { expectedSha256?: string; signal?: AbortSignal },
  ): Promise<Result<{ path: string; sha256: string; sizeBytes: number; created: boolean }>>;
  patch(
    path: string,
    edits: readonly { oldText: string; newText: string }[],
    options: { expectedSha256: string; signal?: AbortSignal },
  ): Promise<Result<{ path: string; sha256: string; sizeBytes: number; editCount: number }>>;
}

export interface ToolContext {
  readonly fs: FileSystem;
  readonly exec: (executable: string, options?: ExecOptions) => Promise<Result<ExecOutput>>;
  readonly cwd: string;
  readonly signal: AbortSignal;
}

export interface ToolContextOptions {
  readonly workspaceId: string;
  readonly cwd?: string;
  readonly signal: AbortSignal;
  readonly executionId: string;
  readonly idempotencyKey: string;
}

/** 工作区路径批量删除（P1 tmp 清理）：仅 `.nova/runs/<runId>/tmp` 形态的目标。 */
export interface WorkspacePathDeletionOptions {
  readonly workspaceId: string;
  readonly relativePaths: readonly string[];
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** `removed` 按顶层目标计数；不存在的路径幂等成功且不计数。 */
export interface WorkspacePathDeletionResult {
  readonly removed: number;
}

export type { RunnerFailure };
