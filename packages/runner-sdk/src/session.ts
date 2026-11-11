import { createHash, randomUUID } from "node:crypto";
import { posix, win32, type PlatformPath } from "node:path";
import { Buffer } from "node:buffer";
import WebSocket from "ws";
import {
  decodeRunnerEnvelope,
  encodeServerEnvelope,
  operationParamsSha256,
  RUNNER_PROTOCOL_VERSION,
  type RemoteOperation,
  type RunnerEnvelope,
} from "@nova/runner-protocol";
import { asUnsigned, failure, messageBytes, safeMessage } from "./errors.js";
import type {
  DirectoryEntry,
  ExecOptions,
  ExecOutput,
  FileSystem,
  OutputChunk,
  Result,
  RunnerFailure,
  RunnerIdentity,
  RunnerSession,
  TextFile,
  ToolContext,
  ToolContextOptions,
} from "./types.js";

const MAX_PENDING_OPERATIONS = 1_024;
const MAX_CONTROL_QUEUE = 1_024;
const MAX_WORK_QUEUE = 64;
const MAX_COMMAND_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_READ_BYTES = 20 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_FILE_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 2_000;
const MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;

interface PendingOperation {
  readonly id: string;
  readonly waiters: ((result: Result<unknown>) => void)[];
  readonly onOutput?: (chunk: OutputChunk) => void;
  readonly decoders: { readonly stdout: TextDecoder; readonly stderr: TextDecoder };
  readonly offset: { stdout: number; stderr: number };
  outputGap: boolean;
  lastSequence: number;
  localOutputBytes: number;
  timeout?: ReturnType<typeof setTimeout>;
  cancelGrace?: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abort?: () => void;
}

interface CancelWaiter {
  readonly resolve: (result: Result<void>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface QueueEntry {
  bytes: Uint8Array;
  readonly priority: "control" | "ack" | "operation";
  readonly finish: (error?: Error) => void;
}

interface Transport {
  readonly socket: WebSocket;
  readonly epoch: string;
  running: boolean;
  readonly controls: QueueEntry[];
  readonly acknowledgements: Map<string, QueueEntry>;
  readonly operations: QueueEntry[];
}

interface ToolState {
  readonly paths: PlatformPath;
  readonly cwd: string;
  ordinal: number;
}

export function parseIdentity(value: unknown): RunnerIdentity {
  if (!record(value) || !string(value.runnerId) || !string(value.bootId))
    throw new TypeError("Runner Hello is missing its device or boot identity");
  const workspaces = Array.isArray(value.workspaces) ? value.workspaces : [];
  if (
    workspaces.length < 1 ||
    workspaces.some(
      (item) =>
        !record(item) ||
        !string(item.workspaceId) ||
        (item.permission !== "READ_ONLY" && item.permission !== "READ_WRITE"),
    )
  )
    throw new TypeError("Runner Hello contains an invalid workspace registration");
  return {
    runnerId: value.runnerId,
    bootId: value.bootId,
    protocolVersion: asUnsigned(value.protocolVersion, "protocol_version"),
    version: string(value.version) ? value.version : "",
    platform: string(value.platform) ? value.platform : "",
    workspaces: workspaces.map((item) => ({
      workspaceId: (item as Record<string, unknown>).workspaceId as string,
      displayName: string((item as Record<string, unknown>).displayName)
        ? ((item as Record<string, unknown>).displayName as string)
        : "",
      permission: (item as Record<string, unknown>).permission as "READ_ONLY" | "READ_WRITE",
    })),
    capabilities: Array.isArray(value.capabilities)
      ? value.capabilities.filter((item): item is string => string(item))
      : [],
    maxConcurrency: asUnsigned(value.maxConcurrency, "max_concurrency"),
  };
}

export class RunnerSessionImpl implements RunnerSession {
  readonly #statusListeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingOperation>();
  readonly #terminal = new Map<string, Result<unknown>>();
  readonly #queries = new Map<string, { operationId: string; resolve: (result: Result<unknown>) => void; timer: ReturnType<typeof setTimeout> }>();
  readonly #cancelWaiters = new Map<string, CancelWaiter[]>();
  readonly #operationDigests = new Map<string, string>();
  readonly #operationDeadlines = new Map<string, { expiresAtUnixMs: string; timeoutMs: number }>();
  readonly #cancelWhenReconnected = new Set<string>();
  #transport: Transport | null = null;
  #closed = false;

  constructor(
    readonly identity: RunnerIdentity,
    readonly principalId: string,
    private readonly report: (diagnostic: { code: string }) => void,
  ) {
    this.bootId = identity.bootId;
  }

  readonly bootId: string;

  get connectionEpoch(): string | null {
    return this.#transport?.epoch ?? null;
  }

  get connected(): boolean {
    return this.#transport?.socket.readyState === WebSocket.OPEN;
  }

  get workspaces(): RunnerIdentity["workspaces"] {
    return this.identity.workspaces;
  }

  attach(socket: WebSocket, epoch: string, heartbeatIntervalMs: number): void {
    if (this.#closed) throw new Error("Runner session is closed");
    const prior = this.#transport;
    const transport: Transport = { socket, epoch, running: false, controls: [], acknowledgements: new Map(), operations: [] };
    this.#transport = transport;
    prior?.socket.close(1000, "Runner reconnected");
    socket.on("message", (frame: WebSocket.RawData, binary: boolean) => {
      try {
        const frameBytes = messageBytes(frame);
        if (!binary || frameBytes.byteLength > 16 * 1024 * 1024) {
          socket.close(1003, "Binary Protobuf frames are required");
          return;
        }
        this.#handleEnvelope(decodeRunnerEnvelope(frameBytes), transport);
      } catch {
        this.report({ code: "RUNNER_PROTOCOL_ERROR" });
        socket.close(1002, "Invalid runner protocol message");
      }
    });
    socket.on("error", () => this.report({ code: "RUNNER_SOCKET_ERROR" }));
    socket.on("close", () => this.#detach(transport));
    this.#sendOn(transport, {
      requestId: "welcome",
      welcome: {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        connectionEpoch: epoch,
        heartbeatIntervalMs,
        acceptedCapabilities: [...this.identity.capabilities],
      },
    }).catch(() => socket.close(1011, "Runner welcome could not be sent"));
    for (const id of this.#pending.keys()) void this.#queueQuery(id);
    for (const id of this.#cancelWhenReconnected) void this.#queueCancel(id);
    for (const id of this.#terminal.keys()) this.#acknowledgeResult(id);
    this.#notifyStatus();
  }

  async cancel(operationId: string): Promise<Result<void>> {
    if (!this.#pending.has(operationId)) return failure("NOT_FOUND", "Operation is no longer active.", "known", operationId);
    this.#cancelWhenReconnected.add(operationId);
    if (!this.connected) return failure("OFFLINE", "Cancellation is queued until the Runner reconnects.", "unknown", operationId);
    return new Promise((resolve) => {
      const waiters = this.#cancelWaiters.get(operationId) ?? [];
      const timer = setTimeout(() => {
        const current = this.#cancelWaiters.get(operationId) ?? [];
        const remaining = current.filter((waiter) => waiter.resolve !== resolve);
        if (remaining.length) this.#cancelWaiters.set(operationId, remaining);
        else this.#cancelWaiters.delete(operationId);
        resolve(failure("OUTCOME_UNKNOWN", "Cancellation was sent but the Runner did not confirm a terminal result.", "unknown", operationId));
      }, CANCEL_GRACE_MS);
      waiters.push({ resolve, timer });
      this.#cancelWaiters.set(operationId, waiters);
      void this.#queueCancel(operationId).catch(() => {
        clearTimeout(timer);
        const current = this.#cancelWaiters.get(operationId) ?? [];
        const remaining = current.filter((waiter) => waiter.resolve !== resolve);
        if (remaining.length) this.#cancelWaiters.set(operationId, remaining);
        else this.#cancelWaiters.delete(operationId);
        resolve(failure("OFFLINE", "Cancellation could not be confirmed.", "unknown", operationId));
      });
    });
  }

  async query(operationId: string): Promise<Result<unknown>> {
    const local = this.#terminal.get(operationId);
    if (local) return local;
    if (!this.#pending.has(operationId))
      return failure("OUTCOME_UNKNOWN", "No retained operation result is available.", "unknown", operationId);
    if (!this.connected) return failure("OFFLINE", "Operation status will be reconciled after reconnection.", "unknown", operationId);
    try {
      return await new Promise((resolve) => {
        const requestId = randomUUID();
        const timer = setTimeout(() => {
          this.#queries.delete(requestId);
          resolve(failure("OUTCOME_UNKNOWN", "Runner did not return the operation result.", "unknown", operationId));
        }, 5_000);
        this.#queries.set(requestId, { operationId, resolve, timer });
        void this.#queueQuery(operationId, requestId).catch(() => {
          clearTimeout(timer);
          this.#queries.delete(requestId);
          resolve(failure("OFFLINE", "Operation status is unavailable.", "unknown", operationId));
        });
      });
    } catch {
      return failure("OFFLINE", "Operation status is unavailable.", "unknown", operationId);
    }
  }

  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#transport?.socket.close(1000, "SDK closed");
    for (const pending of this.#pending.values()) this.#finish(pending, failure("OFFLINE", "Runner SDK closed.", "unknown", pending.id));
    this.#cancelWhenReconnected.clear();
    for (const [requestId, query] of this.#queries) {
      clearTimeout(query.timer);
      query.resolve(failure("OFFLINE", "Runner SDK closed before the operation was reconciled.", "unknown", query.operationId));
      this.#queries.delete(requestId);
    }
    this.#pending.clear();
    this.#notifyStatus();
  }

  runnerRestarted(nextBootId: string): void {
    if (nextBootId === this.bootId || this.#closed) return;
    this.#transport?.socket.close(1000, "Runner process restarted");
    for (const pending of this.#pending.values())
      this.#finish(pending, failure("OUTCOME_UNKNOWN", "Runner restarted before this operation's receipt could be reconciled.", "unknown", pending.id));
    this.#pending.clear();
    this.#cancelWhenReconnected.clear();
    this.#notifyStatus();
  }

  createToolContext(options: ToolContextOptions): ToolContext {
    const workspace = this.identity.workspaces.find((item) => item.workspaceId === options.workspaceId);
    if (!workspace) throw new TypeError("Tool workspace is not registered on this Runner");
    const pathImpl: PlatformPath = this.identity.platform.toLowerCase().startsWith("windows") ? win32 : posix;
    const normalizeVirtual = (value: string) => {
      if (value.includes("\0") || pathImpl.isAbsolute(value)) throw new TypeError("Runner paths must be workspace-relative");
      const normalized = pathImpl.normalize(value || ".");
      if (normalized === ".." || normalized.startsWith(`..${pathImpl.sep}`)) throw new TypeError("Runner path escapes its workspace");
      return normalized;
    };
    const state: ToolState = {
      paths: pathImpl,
      cwd: normalizeVirtual(options.cwd ?? "."),
      ordinal: 0,
    };
    const resolve = (value: string) => {
      try { return normalizeVirtual(pathImpl.join(state.cwd, value || ".")); }
      catch { return value; }
    };
    const permitted = workspace.permission === "READ_WRITE";
    const thisSession = this;
    const fs: FileSystem = {
      async read(path, readOptions = {}) {
        return thisSession.#run(
          state,
          options,
          "readText",
          {
            path: resolve(path),
            offset: String(readOptions.offset ?? 1),
            limit: readOptions.limit ?? 200,
            maxBytes: 262_144,
          },
          DEFAULT_FILE_TIMEOUT_MS,
          readOptions.signal,
        ).then((result) => thisSession.#readTextResult(result));
      },
      async readBytes(path, readOptions = {}) {
        let chunks: Uint8Array[] = [];
        let nextOffset = 0;
        let totalSize = 0;
        let digest = "";
        while (nextOffset === 0 || nextOffset < totalSize) {
          const result = await thisSession.#run(
            state,
            options,
            "readFile",
            { path: resolve(path), offset: String(nextOffset), maxBytes: 262_144 },
            DEFAULT_FILE_TIMEOUT_MS,
            readOptions.signal,
          );
          if (!result.ok) return result as Result<Uint8Array>;
          if (!record(result.value)) return failure("IO", "Runner returned an invalid file result.", "unknown");
          const payload = selected(result.value, "readFile");
          const data = getBytes(payload.contents);
          totalSize = asUnsigned(payload.totalSize, "total_size");
          nextOffset = asUnsigned(payload.offset, "offset") + data.byteLength;
          digest = string(payload.sha256) ? payload.sha256 : "";
          if (nextOffset > totalSize || chunks.reduce((size, chunk) => size + chunk.byteLength, 0) + data.byteLength > MAX_READ_BYTES)
            return failure("TOO_LARGE", "Binary file exceeds the 20 MiB read limit.", "known");
          chunks.push(data);
          if (data.byteLength === 0 && nextOffset < totalSize)
            return failure("IO", "Runner returned an empty non-terminal file chunk.", "unknown");
          if (totalSize === 0) break;
        }
        if (!/^[a-f\d]{64}$/i.test(digest)) return failure("IO", "Runner omitted the file integrity digest.", "unknown");
        const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
        let cursor = 0;
        for (const chunk of chunks) {
          output.set(chunk, cursor);
          cursor += chunk.byteLength;
        }
        if (createHash("sha256").update(output).digest("hex") !== digest.toLowerCase())
          return failure("IO", "Binary file integrity check failed.", "unknown");
        return { ok: true, value: output };
      },
      async list(path = ".", listOptions = {}) {
        const result = await thisSession.#run(
          state,
          options,
          "listFiles",
          { path: resolve(path), depth: listOptions.depth ?? 1, maxEntries: listOptions.maxEntries ?? 10_000 },
          DEFAULT_FILE_TIMEOUT_MS,
          listOptions.signal,
        );
        if (!result.ok) return result as Result<DirectoryEntry[]>;
        if (!record(result.value)) return failure("IO", "Runner returned an invalid directory result.", "unknown");
        const value = selected(result.value, "listFiles");
        return {
          ok: true,
          value: (Array.isArray(value.entries) ? value.entries : []).map((entry): DirectoryEntry => {
            if (!record(entry)) throw new TypeError("Runner returned an invalid directory entry");
            let kind: DirectoryEntry["kind"] = "file";
            if (entry.kind === "DIRECTORY") kind = "dir";
            else if (entry.kind === "SYMLINK") kind = "symlink";
            return {
              path: string(entry.path) ? entry.path : "",
              kind,
              sizeBytes: asUnsigned(entry.sizeBytes, "size_bytes"),
            };
          }),
        };
      },
      async grep(pattern, grepOptions = {}) {
        const result = await thisSession.#run(
          state,
          options,
          "search",
          {
            query: pattern,
            path: resolve(grepOptions.path ?? "."),
            glob: grepOptions.glob ?? "",
            maxResults: grepOptions.maxResults ?? 100,
          },
          DEFAULT_FILE_TIMEOUT_MS,
          grepOptions.signal,
        );
        if (!result.ok) return result as Result<{ matches: { path: string; line: number; text: string }[]; truncated: boolean }>;
        if (!record(result.value)) return failure("IO", "Runner returned an invalid search result.", "unknown");
        const value = selected(result.value, "search");
        return {
          ok: true,
          value: {
            matches: (Array.isArray(value.matches) ? value.matches : []).map((item) => {
              if (!record(item)) throw new TypeError("Runner returned an invalid search match");
              return {
                path: string(item.path) ? item.path : "",
                line: asUnsigned(item.line, "line"),
                text: string(item.text) ? item.text : "",
              };
            }),
            truncated: value.truncated === true,
          },
        };
      },
      async write(path, content, writeOptions = {}) {
        if (!permitted) return failure("DENIED", "Workspace is registered read-only.", "known");
        const data = new TextEncoder().encode(content);
        if (data.byteLength > 1_048_576) return failure("TOO_LARGE", "Text files are limited to 1 MiB.", "known");
        const result = await thisSession.#run(
          state,
          options,
          "writeFile",
          { path: resolve(path), contents: data, expectedSha256: writeOptions.expectedSha256 ?? "" },
          DEFAULT_FILE_TIMEOUT_MS,
          writeOptions.signal,
        );
        if (!result.ok) return result as Result<{ path: string; sha256: string; sizeBytes: number; created: boolean }>;
        if (!record(result.value)) return failure("IO", "Runner returned an invalid write result.", "unknown");
        const value = selected(result.value, "writeFile");
        return {
          ok: true,
          value: {
            path: string(value.path) ? value.path : resolve(path),
            sha256: string(value.sha256) ? value.sha256 : "",
            sizeBytes: asUnsigned(value.sizeBytes, "size_bytes"),
            created: !writeOptions.expectedSha256,
          },
        };
      },
      async patch(path, edits, patchOptions) {
        if (!permitted) return failure("DENIED", "Workspace is registered read-only.", "known");
        if (!patchOptions.expectedSha256) return failure("INVALID", "File edits require a content digest.", "known");
        const result = await thisSession.#run(
          state,
          options,
          "applyPatch",
          { path: resolve(path), edits, expectedSha256: patchOptions.expectedSha256 },
          DEFAULT_FILE_TIMEOUT_MS,
          patchOptions.signal,
        );
        if (!result.ok) return result as Result<{ path: string; sha256: string; sizeBytes: number; editCount: number }>;
        if (!record(result.value)) return failure("IO", "Runner returned an invalid patch result.", "unknown");
        const value = selected(result.value, "applyPatch");
        return {
          ok: true,
          value: {
            path: string(value.path) ? value.path : resolve(path),
            sha256: string(value.sha256) ? value.sha256 : "",
            sizeBytes: asUnsigned(value.sizeBytes, "size_bytes"),
            editCount: asUnsigned(value.editCount, "edit_count"),
          },
        };
      },
    };
    const exec = async (executable: string, execOptions: ExecOptions = {}): Promise<Result<ExecOutput>> => {
      if (!permitted) return failure("DENIED", "Workspace is registered read-only.", "known");
      const timeoutMs = execOptions.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_COMMAND_TIMEOUT_MS)
        return failure("INVALID", "Command timeout must be between 1 and 900000 milliseconds.", "known");
      if (new TextEncoder().encode(executable).byteLength > 32_768 || executable.trim() !== executable || !executable)
        return failure("INVALID", "Executable name is invalid.", "known");
      const stdin = typeof execOptions.stdin === "string" ? new TextEncoder().encode(execOptions.stdin) : execOptions.stdin;
      if ((stdin?.byteLength ?? 0) > 524_288) return failure("TOO_LARGE", "Command stdin is limited to 512 KiB.", "known");
      const result = await thisSession.#run(
        state,
        options,
        "executeCommand",
        {
          executable,
          args: execOptions.args ?? [],
          cwd: resolve(execOptions.cwd ?? state.cwd),
          env: execOptions.env ?? {},
          timeoutMs,
          stdin: stdin ?? new Uint8Array(),
        },
        timeoutMs + CANCEL_GRACE_MS,
        execOptions.signal,
        execOptions.onOutput,
      );
      if (!result.ok) return result as Result<ExecOutput>;
      if (!record(result.value)) return failure("IO", "Runner returned an invalid command result.", "unknown");
      const operationResult = result.value;
      const value = selected(operationResult, "executeCommand");
      return {
        ok: true,
        value: {
          operationId: string(operationResult.operationId) ? operationResult.operationId : "",
          exitCode: typeof value.exitCode === "number" ? value.exitCode : -1,
          stdout: decodeUtf8(getBytes(value.stdout)),
          stderr: decodeUtf8(getBytes(value.stderr)),
          durationMs: asUnsigned(value.durationMs, "duration_ms"),
          truncated: value.outputTruncated === true,
          outputGap: operationResult.outputGap === true,
        },
      };
    };
    return { fs, exec, cwd: state.cwd, signal: options.signal };
  }

  #readTextResult(result: Result<unknown>): Result<TextFile> {
    if (!result.ok) return result as Result<TextFile>;
    if (!record(result.value)) return failure("IO", "Runner returned an invalid text result.", "unknown");
    const value = selected(result.value, "readText");
    return {
      ok: true,
      value: {
        text: string(value.text) ? value.text : "",
        startLine: asUnsigned(value.startLine, "start_line"),
        endLine: asUnsigned(value.endLine, "end_line"),
        ...(value.totalLines === undefined ? {} : { totalLines: asUnsigned(value.totalLines, "total_lines") }),
        totalSize: asUnsigned(value.totalSize, "total_size"),
        sha256: string(value.sha256) ? value.sha256 : "",
        truncated: value.truncated === true,
        lineTruncated: value.lineTruncated === true,
      },
    };
  }

  async #run(
    state: ToolState,
    context: ToolContextOptions,
    kind: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    additionalSignal?: AbortSignal,
    onOutput?: (chunk: OutputChunk) => void,
  ): Promise<Result<unknown>> {
    const operationId = createHash("sha256")
      .update(JSON.stringify([this.principalId, context.idempotencyKey, kind, state.ordinal++]), "utf8")
      .digest("hex");
    const now = Date.now();
    let deadline = this.#operationDeadlines.get(operationId);
    if (!deadline) {
      deadline = {
        expiresAtUnixMs: String(now + Math.min(timeoutMs + 60_000, 16 * 60_000)),
        timeoutMs,
      };
      this.#operationDeadlines.set(operationId, deadline);
      while (this.#operationDeadlines.size > MAX_PENDING_OPERATIONS)
        this.#operationDeadlines.delete(this.#operationDeadlines.keys().next().value as string);
    }
    const operation: RemoteOperation = {
      operationId,
      targetBootId: this.bootId,
      workspaceId: context.workspaceId,
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      expiresAtUnixMs: deadline.expiresAtUnixMs,
      timeoutMs: deadline.timeoutMs,
      params: { kind, ...params } as RemoteOperation["params"],
    };
    return this.#submit(operation, context.signal, additionalSignal, onOutput);
  }

  #submit(
    operation: RemoteOperation,
    runSignal: AbortSignal,
    additionalSignal?: AbortSignal,
    onOutput?: (chunk: OutputChunk) => void,
  ): Promise<Result<unknown>> {
    const operationId = operation.operationId;
    const paramsKind = operation.params.kind;
    const paramsField = { listFiles: "listFiles", readFile: "readFile", readText: "readText", search: "search", writeFile: "writeFile", applyPatch: "applyPatch", executeCommand: "executeCommand" }[paramsKind];
    if (!paramsField) return Promise.resolve(failure("UNSUPPORTED", "Unsupported Runner operation.", "known", operationId));
    const wireOperation: Record<string, unknown> = {
      operationId,
      targetBootId: operation.targetBootId,
      workspaceId: operation.workspaceId,
      protocolVersion: operation.protocolVersion,
      expiresAtUnixMs: operation.expiresAtUnixMs,
      timeoutMs: operation.timeoutMs,
      [paramsField]: wireParams(operation.params),
    };
    let digest: string;
    try {
      const digestBytes = operationParamsSha256(wireOperation);
      wireOperation.paramsSha256 = digestBytes;
      digest = Buffer.from(digestBytes).toString("hex");
      if (encodeServerEnvelope({ requestId: operationId, operation: wireOperation }).byteLength > 16 * 1024 * 1024)
        return Promise.resolve(failure("TOO_LARGE", "Runner operation frame exceeds the 16 MiB limit.", "known", operationId));
    } catch {
      return Promise.resolve(failure("INVALID", "Operation parameters are invalid.", "known", operationId));
    }
    const priorDigest = this.#operationDigests.get(operationId);
    if (priorDigest && priorDigest !== digest)
      return Promise.resolve(failure("IDEMPOTENCY_CONFLICT", "Operation ID was reused with different parameters.", "known", operationId));
    const retained = this.#pending.get(operationId);
    if (retained) return new Promise((resolve) => {
      const result = this.#terminal.get(operationId);
      if (result) resolve(result);
      else retained.waiters.push(resolve);
    });
    const prior = this.#terminal.get(operationId);
    if (prior) return Promise.resolve(prior);
    if (this.#closed) return Promise.resolve(failure("OFFLINE", "Runner SDK is closed.", "known", operationId));
    if (!this.connected) return Promise.resolve(failure("OFFLINE", "Runner is not connected.", "known", operationId));
    if (this.#pending.size >= MAX_PENDING_OPERATIONS)
      return Promise.resolve(failure("BUSY", "The bounded operation registry is full.", "known", operationId));
    while (this.#pending.size + this.#terminal.size >= MAX_PENDING_OPERATIONS && this.#terminal.size > 0) {
      const oldest = this.#terminal.keys().next().value as string;
      this.#terminal.delete(oldest);
      this.#operationDigests.delete(oldest);
      this.#operationDeadlines.delete(oldest);
    }
    if (this.#pending.size + this.#terminal.size >= MAX_PENDING_OPERATIONS)
      return Promise.resolve(failure("BUSY", "All bounded operation slots are active.", "known", operationId));
    if (runSignal.aborted || additionalSignal?.aborted)
      return Promise.resolve(failure("CANCELLED", "Operation cancelled before dispatch.", "known", operationId));
    this.#operationDigests.set(operationId, digest);
    while (this.#operationDigests.size > MAX_PENDING_OPERATIONS) this.#operationDigests.delete(this.#operationDigests.keys().next().value as string);

    return new Promise((resolve) => {
      const pending: PendingOperation = {
        id: operationId,
        waiters: [resolve],
        decoders: { stdout: new TextDecoder("utf-8"), stderr: new TextDecoder("utf-8") },
        offset: { stdout: 0, stderr: 0 },
        outputGap: false,
        lastSequence: 0,
        localOutputBytes: 0,
        ...(onOutput ? { onOutput } : {}),
      };
      this.#pending.set(operationId, pending);
      const cancel = () => {
        if (!this.#pending.has(operationId) || pending.cancelGrace) return;
        this.#cancelWhenReconnected.add(operationId);
        if (this.connected) void this.#queueCancel(operationId);
        pending.cancelGrace = setTimeout(() => {
          this.#finish(
            pending,
            failure("OUTCOME_UNKNOWN", "Operation cancellation was not confirmed before its deadline.", "unknown", operationId),
          );
        }, CANCEL_GRACE_MS);
      };
      const signals = [runSignal, additionalSignal].filter((signal): signal is AbortSignal => signal !== undefined);
      pending.abort = cancel;
      if (signals.length > 1) pending.signal = AbortSignal.any(signals);
      else if (signals[0]) pending.signal = signals[0];
      pending.signal?.addEventListener("abort", cancel, { once: true });
      pending.timeout = setTimeout(cancel, operation.timeoutMs + CANCEL_GRACE_MS);
      this.#send({ requestId: operationId, operation: wireOperation }, "operation")
        .then(() => undefined)
        .catch(() => {
          this.#finish(
            pending,
            failure("OUTCOME_UNKNOWN", "The Runner may have received this operation; it will never be replayed.", "unknown", operationId),
          );
        });
    });
  }

  #handleEnvelope(envelope: RunnerEnvelope, transport: Transport): void {
    if (transport !== this.#transport) return;
    const requestId = string(envelope.requestId) ? envelope.requestId : "";
    switch (envelope.payload) {
      case "heartbeat":
        this.#notifyStatus();
        return;
      case "reconcile": {
        const reconcile = record(envelope.reconcile) ? envelope.reconcile : {};
        for (const candidate of [...stringArray(reconcile.activeOperationIds), ...stringArray(reconcile.unacknowledgedTerminalIds)]) {
          if (this.#pending.has(candidate)) void this.#queueQuery(candidate);
        }
        return;
      }
      case "accepted":
        return;
      case "output": {
        if (!record(envelope.output)) return;
        const output = envelope.output;
        const id = string(output.operationId) ? output.operationId : "";
        const pending = this.#pending.get(id);
        const sequence = asUnsigned(output.sequence, "sequence");
        if (pending) {
          if (sequence <= pending.lastSequence) {
            void this.#send({ requestId: randomUUID(), acknowledgeOutput: { operationId: id, bootId: this.bootId, sequence: String(sequence) } }, "control").catch(() => undefined);
            return;
          }
          if (sequence !== pending.lastSequence + 1) pending.outputGap = true;
          pending.lastSequence = Math.max(pending.lastSequence, sequence);
          const stream = output.stream === "STDERR" ? "stderr" : "stdout";
          const offset = asUnsigned(output.offset, "offset");
          if (offset !== pending.offset[stream]) pending.outputGap = true;
          pending.offset[stream] = offset + getBytes(output.data).byteLength;
          pending.localOutputBytes += getBytes(output.data).byteLength;
          if (pending.localOutputBytes > MAX_COMMAND_OUTPUT_BYTES) pending.outputGap = true;
          else {
            const text = pending.decoders[stream].decode(getBytes(output.data), { stream: true });
            if (text) {
              try {
                pending.onOutput?.({ stream, text });
              } catch {
                this.report({ code: "OUTPUT_OBSERVER_FAILED" });
              }
            }
          }
        }
        void this.#send(
          {
            requestId: randomUUID(),
            acknowledgeOutput: { operationId: id, bootId: this.bootId, sequence: String(sequence) },
          },
          "ack",
        ).catch(() => undefined);
        return;
      }
      case "result": {
        if (!record(envelope.result)) return;
        const result = envelope.result;
        const id = string(result.operationId) ? result.operationId : "";
        const status = string(result.status) ? result.status : "FAILED";
        if (status === "ACCEPTED" || status === "RUNNING") return;
        this.#cancelWhenReconnected.delete(id);
        const query = this.#queries.get(requestId);
        const target = query?.operationId ?? id;
        if (id !== target) {
          this.report({ code: "RUNNER_RESULT_ID_MISMATCH" });
          return;
        }
        const pending = this.#pending.get(target);
        const lastOutputSequence = asUnsigned(result.lastOutputSequence, "last_output_sequence");
        const response = runnerResult(
          result,
          pending?.outputGap === true || (pending !== undefined && pending.lastSequence < lastOutputSequence),
        );
        if (!pending) {
          if (query) {
            clearTimeout(query.timer);
            this.#queries.delete(requestId);
            query.resolve(response);
          }
          this.#resolveQueries(target, response);
          this.#acknowledgeResult(id);
          return;
        }
        for (const stream of ["stdout", "stderr"] as const) {
          const trailing = pending.decoders[stream].decode();
          if (trailing) {
            try {
              pending.onOutput?.({ stream, text: trailing });
            } catch {
              this.report({ code: "OUTPUT_OBSERVER_FAILED" });
            }
          }
        }
        this.#finish(pending, response);
        this.#acknowledgeResult(id);
        return;
      }
      case "rejection":
        this.report({ code: "RUNNER_REJECTED_CONNECTION" });
        this.#transport?.socket.close(1008, "Runner connection rejected");
        return;
      default:
        this.report({ code: "UNEXPECTED_RUNNER_MESSAGE" });
    }
  }

  #acknowledgeResult(id: string): void {
    void this.#send({ requestId: randomUUID(), acknowledge: { operationId: id, bootId: this.bootId } }, "control").catch(
      () => undefined,
    );
  }

  #queueQuery(id: string, requestId = randomUUID()): Promise<void> {
    return this.#send({ requestId, query: { operationId: id, targetBootId: this.bootId } }, "control");
  }

  #queueCancel(id: string): Promise<void> {
    return this.#send({ requestId: randomUUID(), cancel: { operationId: id, targetBootId: this.bootId } }, "control");
  }

  #send(envelope: Record<string, unknown>, priority: QueueEntry["priority"]): Promise<void> {
    const transport = this.#transport;
    if (!transport || transport.socket.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("Runner is offline"));
    if (priority === "operation" && transport.operations.length >= MAX_WORK_QUEUE)
      return Promise.reject(new Error("Runner operation queue is full"));
    if (priority === "control" && transport.controls.length >= MAX_CONTROL_QUEUE)
      return Promise.reject(new Error("Runner control queue is full"));
    let bytes: Uint8Array;
    try {
      bytes = encodeServerEnvelope(envelope);
    } catch {
      return Promise.reject(new TypeError("Invalid Runner envelope"));
    }
    return new Promise((resolve, reject) => {
      const entry: QueueEntry = {
        bytes,
        priority,
        finish: (error) => (error ? reject(error) : resolve()),
      };
      if (priority === "control") transport.controls.push(entry);
      else if (priority === "operation") transport.operations.push(entry);
      else {
        const payload = record(envelope.acknowledgeOutput) ? envelope.acknowledgeOutput : {};
        const id = string(payload.operationId) ? payload.operationId : "";
        if (!id) { reject(new TypeError("Output acknowledgement has no operation ID")); return; }
        const prior = transport.acknowledgements.get(id);
        if (prior) {
          prior.bytes = bytes;
          resolve();
          return;
        }
        if (transport.acknowledgements.size >= MAX_PENDING_OPERATIONS) {
          reject(new Error("Runner output acknowledgement queue is full"));
          return;
        }
        transport.acknowledgements.set(id, entry);
      }
      void this.#pump(transport);
    });
  }

  async #sendOn(transport: Transport, envelope: Record<string, unknown>): Promise<void> {
    const bytes = encodeServerEnvelope(envelope);
    await new Promise<void>((resolve, reject) => {
      if (transport.socket.readyState !== WebSocket.OPEN) {
        reject(new Error("Runner is offline"));
        return;
      }
      transport.socket.send(bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
    });
  }

  async #pump(transport: Transport): Promise<void> {
    if (transport.running) return;
    transport.running = true;
    try {
      while (this.#transport === transport && transport.socket.readyState === WebSocket.OPEN) {
        const control = transport.controls.shift();
        let acknowledgement: [string, QueueEntry] | undefined;
        if (!control) {
          const firstAcknowledgement = transport.acknowledgements.entries().next();
          acknowledgement = firstAcknowledgement.done ? undefined : firstAcknowledgement.value;
          if (acknowledgement) transport.acknowledgements.delete(acknowledgement[0]);
        }
        const entry = control ?? acknowledgement?.[1] ?? transport.operations.shift();
        if (!entry) break;
        try {
          await new Promise<void>((resolve, reject) => {
            if (transport.socket.readyState !== WebSocket.OPEN) {
              reject(new Error("Runner is offline"));
              return;
            }
            transport.socket.send(entry.bytes, { binary: true }, (error) => (error ? reject(error) : resolve()));
          });
          entry.finish();
        } catch {
          entry.finish(new Error("Runner connection lost"));
          transport.socket.close(1011, "Protobuf send failed");
        }
      }
    } finally {
      transport.running = false;
      if (this.#transport === transport && (transport.controls.length || transport.acknowledgements.size || transport.operations.length))
        queueMicrotask(() => void this.#pump(transport));
    }
  }

  #detach(transport: Transport): void {
    if (this.#transport !== transport) return;
    this.#transport = null;
    for (const entry of [
      ...transport.operations.splice(0),
      ...transport.controls.splice(0),
      ...transport.acknowledgements.values(),
    ])
      entry.finish(new Error("Runner connection lost"));
    this.#notifyStatus();
  }

  #finish(pending: PendingOperation, result: Result<unknown>): void {
    if (!this.#pending.has(pending.id)) return;
    this.#pending.delete(pending.id);
    if (pending.timeout) clearTimeout(pending.timeout);
    if (pending.cancelGrace) clearTimeout(pending.cancelGrace);
    if (pending.abort) pending.signal?.removeEventListener("abort", pending.abort);
    this.#terminal.set(pending.id, result);
    while (this.#terminal.size > MAX_PENDING_OPERATIONS) {
      const oldest = this.#terminal.keys().next().value as string;
      this.#terminal.delete(oldest);
      this.#operationDigests.delete(oldest);
      this.#operationDeadlines.delete(oldest);
    }
    for (const resolve of pending.waiters) resolve(result);
    this.#resolveQueries(pending.id, result);
    const cancelWaiters = this.#cancelWaiters.get(pending.id);
    if (cancelWaiters) {
      for (const waiter of cancelWaiters) {
        clearTimeout(waiter.timer);
        if (!result.ok && result.error.code === "CANCELLED") waiter.resolve({ ok: true, value: undefined });
        else if (!result.ok) waiter.resolve(failure(result.error.code, result.error.message, result.error.outcome, pending.id));
        else waiter.resolve(failure("TOO_LATE", "Operation completed before cancellation took effect.", "known", pending.id));
      }
      this.#cancelWaiters.delete(pending.id);
    }
  }

  #resolveQueries(operationId: string, result: Result<unknown>): void {
    for (const [requestId, query] of this.#queries) {
      if (query.operationId !== operationId) continue;
      clearTimeout(query.timer);
      this.#queries.delete(requestId);
      query.resolve(result);
    }
  }

  #notifyStatus(): void {
    for (const listener of this.#statusListeners) {
      try { listener(); }
      catch { this.report({ code: "STATUS_OBSERVER_FAILED" }); }
    }
  }
}

export function toToolContext(session: RunnerSession, options: ToolContextOptions): ToolContext {
  return session.createToolContext(options);
}

function selected(value: Record<string, unknown>, kind: string): Record<string, unknown> {
  if (value.result !== kind || !record(value[kind]))
    throw new TypeError("Runner returned an operation result with the wrong parameter type");
  return value[kind];
}

function wireParams(params: RemoteOperation["params"]): Record<string, unknown> {
  const { kind, ...value } = params;
  return value;
}

function errorMessage(result: Record<string, unknown>): string {
  if (record(result.error) && string(result.error.message)) return safeMessage(result.error.message);
  return "Runner operation failed.";
}

function runnerResult(result: Record<string, unknown>, localOutputGap: boolean): Result<unknown> {
  const status = string(result.status) ? result.status : "FAILED";
  if (status === "OUTCOME_UNKNOWN")
    return failure("OUTCOME_UNKNOWN", errorMessage(result), "unknown", string(result.operationId) ? result.operationId : undefined);
  if (record(result.error)) {
    const code = string(result.error.code) ? result.error.code : "IO";
    const message = string(result.error.message) ? safeMessage(result.error.message) : "Runner operation failed.";
    const stdout = decodeUtf8(getBytes(result.error.stdout));
    const stderr = decodeUtf8(getBytes(result.error.stderr));
    const details = stdout || stderr || result.error.outputGap === true || result.error.outputTruncated === true
      ? { stdout, stderr, outputGap: localOutputGap || result.error.outputGap === true, outputTruncated: result.error.outputTruncated === true }
      : undefined;
    return failure(code, message, "known", string(result.operationId) ? result.operationId : undefined, details);
  }
  if (status === "SUCCEEDED")
    return { ok: true, value: { ...result, outputGap: localOutputGap || result.outputGap === true } };
  let code = "IO";
  if (status === "CANCELLED") code = "CANCELLED";
  else if (status === "TIMED_OUT") code = "TIMEOUT";
  return failure(code, errorMessage(result), "known", string(result.operationId) ? result.operationId : undefined);
}

function getBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value.filter((byte) => Number.isInteger(byte) && byte >= 0 && byte < 256));
  return new Uint8Array(0);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function string(value: unknown): value is string {
  return typeof value === "string";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
