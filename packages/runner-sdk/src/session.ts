// Runner Session（docs/runner-sdk.md §3/§5）：request_id / execution_id 关联、
// execute 事件流、cancel、文件操作。连接生命周期由 server.ts 持有，
// 本文件只负责"一条已接纳连接上的复用协议"。
//
// 硬规矩：不重发、不自动重试；传输失效时所有挂起请求与事件队列以
// RUNNER_UNAVAILABLE 失败（docs/runner-sdk.md §4/§6）。
import { create, type MessageInitShape } from "@bufbuild/protobuf";
import {
  CancelRequestSchema,
  FileOpRequestSchema,
  GrepOpSchema,
  ListOpSchema,
  MkdirOpSchema,
  ReadFileRequestSchema,
  RemoveOpSchema,
  RenameOpSchema,
  StatOpSchema,
  TempDirOpSchema,
  WriteFileRequestSchema,
} from "./gen/execution_pb.js";
import type {
  DirEntry,
  ExecuteRequest,
  ExecutionEvent,
  FileInfo,
  FileOpResponse,
  GrepResult,
  WriteFileResponse,
} from "./gen/execution_pb.js";
import { RunnerState } from "./gen/runner_pb.js";
import type { Register, RunnerEnvelope, ServerEnvelopeSchema } from "./gen/runner_pb.js";
import { RunnerError, fromWireError, runnerUnavailable } from "./errors.js";

export type RunnerIdentity = Register;

export type ServerEnvelopeInit = MessageInitShape<typeof ServerEnvelopeSchema>;

// 有界队列（docs/runner-sdk.md §5）：容量满时 push 挂起 → 背压沿
// gRPC flow control 传回 Runner 的有界 channel。
export const ended = Symbol("queue ended");

export class BoundedQueue<T> {
  private items: T[] = [];
  private done = false;
  private error: RunnerError | null = null;
  private notFull: Array<() => void> = [];
  private notEmpty: Array<() => void> = [];

  constructor(private readonly capacity: number) {}

  async push(item: T): Promise<void> {
    while (this.items.length >= this.capacity) {
      if (this.done) return; // 消费端已离场，丢弃而非堆积
      await new Promise<void>((resolve) => this.notFull.push(resolve));
    }
    this.items.push(item);
    this.notEmpty.shift()?.();
  }

  async shift(): Promise<T | typeof ended> {
    while (this.items.length === 0) {
      if (this.error !== null) throw this.error;
      if (this.done) return ended;
      await new Promise<void>((resolve) => this.notEmpty.push(resolve));
    }
    const item = this.items.shift()!;
    this.notFull.shift()?.();
    return item;
  }

  close(error?: RunnerError): void {
    if (this.done) return;
    this.done = true;
    this.error = error ?? null;
    for (const wake of this.notFull.splice(0)) wake();
    for (const wake of this.notEmpty.splice(0)) wake();
  }
}

// 协议层文件面（proto 类型）。与 agent-core 的 FileSystem 不同：
// 这里抛 RunnerError，到 ToolContext 的 Result 转换在 tool-context.ts。
export interface FileSystemOps {
  stat(path: string): Promise<FileInfo>;
  list(path: string, depth?: number): Promise<DirEntry[]>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  tempDir(prefix?: string): Promise<string>;
  grep(pattern: string, opts?: { path?: string; glob?: string; maxResults?: number }): Promise<GrepResult>;
  readFile(path: string, opts?: { offset?: number; limit?: number }): Promise<{ data: Uint8Array; totalSize: number }>;
  writeFile(path: string, data: Uint8Array, opts?: { append?: boolean }): Promise<WriteFileResponse>;
}

export interface RunnerSession {
  readonly identity: RunnerIdentity;
  readonly generation: string;
  // 心跳只更新事实；状态推导（DISCONNECTED 等）是 Runner Module 的职责
  readonly lastHeartbeatAt: number | null;
  readonly state: RunnerState;
  readonly running: number;
  onStatus(listener: () => void): () => void;
  execute(request: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ExecutionEvent>;
  cancel(executionId: string): Promise<void>;
  readonly fs: FileSystemOps;
  close(): Promise<void>;
}

const EXECUTION_BUFFER = 64; // 每个 execution 的事件缓冲上限
const WRITE_CHUNK = 256 * 1024; // WriteFile 分片，与 ReadFile chunk 对齐

type Pending = {
  deliver(env: RunnerEnvelope): void;
  fail(err: RunnerError): void;
};

export class RunnerSessionImpl implements RunnerSession {
  lastHeartbeatAt: number | null = null;
  state: RunnerState = RunnerState.UNSPECIFIED;
  running = 0;

  private requestSeq = 0;
  private pending = new Map<string, Pending>();
  private executions = new Map<string, BoundedQueue<ExecutionEvent>>();
  private closed = false;
  private statusListeners = new Set<() => void>();

  constructor(
    readonly identity: RunnerIdentity,
    readonly generation: string,
    private readonly outbound: BoundedQueue<ServerEnvelopeInit>,
  ) {
    this.fs = this.buildFs();
  }

  readonly fs: FileSystemOps;

  // —— 入站分发（server.ts 的读取循环调用）——

  async handleEnvelope(env: RunnerEnvelope): Promise<void> {
    switch (env.payload.case) {
      case "executionEvent": {
        const event = env.payload.value;
        const queue = this.executions.get(event.executionId);
        if (queue === undefined) return; // 已被消费端放弃的 execution
        await queue.push(event); // 背压点：缓冲满 → 阻塞读取 → HTTP/2 flow control
        if (event.event.case === "finished") queue.close();
        return;
      }
      case "heartbeat":
        this.lastHeartbeatAt = Date.now();
        this.state = env.payload.value.state;
        this.running = env.payload.value.running;
        this.emitStatus();
        return;
      case "fileChunk": {
        // 流式响应：handler 自己决定何时终结，不在这里删除 pending
        this.pending.get(env.requestId)?.deliver(env);
        return;
      }
      case "fileOpResponse":
      case "writeFileResponse":
      case "cancelResponse":
      case "error": {
        const handler = this.pending.get(env.requestId);
        if (handler === undefined) return; // 迟到的重复响应
        this.pending.delete(env.requestId);
        handler.deliver(env);
        return;
      }
      default:
        return; // register 由 server.ts 在接纳前消费，其余不属于会话内消息
    }
  }

  // —— 执行面 ——

  execute(request: ExecuteRequest, signal?: AbortSignal): AsyncIterable<ExecutionEvent> {
    const session = this;
    async function* events(): AsyncIterable<ExecutionEvent> {
      if (signal?.aborted) throw new RunnerError("CANCELLED", "aborted before start");
      if (session.closed) throw runnerUnavailable("session closed");
      if (session.executions.has(request.executionId)) {
        throw new RunnerError("INVALID", `duplicate execution_id: ${request.executionId}`);
      }
      const queue = new BoundedQueue<ExecutionEvent>(EXECUTION_BUFFER);
      session.executions.set(request.executionId, queue);
      // 取消不是关流（docs/runner-sdk.md §5）：abort 只发 CancelRequest，
      // 事件继续读到终态或连接失效
      const onAbort = () => {
        session.cancel(request.executionId).catch(() => {});
      };
      try {
        signal?.addEventListener("abort", onAbort, { once: true });
        await session.send({ requestId: "", payload: { case: "execute", value: request } });
        for (;;) {
          const item = await queue.shift();
          if (item === ended) return;
          yield item;
          if (item.event.case === "finished") return;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        session.executions.delete(request.executionId);
      }
    }
    return events();
  }

  async cancel(executionId: string): Promise<void> {
    if (this.closed) return; // 连接已失效，取消无意义
    const requestId = this.nextRequestId();
    const response = this.awaitSingle(requestId);
    await this.send({
      requestId,
      payload: { case: "cancel", value: create(CancelRequestSchema, { executionId }) },
    });
    try {
      await response; // found=false 是事实不是错误：execution 可能已终态
    } catch {
      // 取消是尽力而为；连接失效时事件队列会自行失败
    }
  }

  async close(): Promise<void> {
    this.failTransport(runnerUnavailable("session closed"));
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  // 连接失效 / 会话关闭：唯一的状态收口。先置 closed 再失败挂起项，
  // 保证 failTransport 与 execute/writeFile 注册之间无窗口。
  failTransport(err: RunnerError): void {
    if (this.closed) return;
    this.closed = true;
    this.lastHeartbeatAt = null;
    this.state = RunnerState.UNSPECIFIED;
    this.running = 0;
    for (const pending of this.pending.values()) pending.fail(err);
    this.pending.clear();
    for (const queue of this.executions.values()) queue.close(err);
    this.executions.clear();
    this.outbound.close(); // 让 server.ts 的 yield 循环收尾
    this.emitStatus();
    this.statusListeners.clear();
  }

  // —— 内部 ——

  private nextRequestId(): string {
    this.requestSeq += 1;
    return `request-${this.requestSeq}`;
  }

  private emitStatus(): void {
    for (const listener of this.statusListeners) listener();
  }

  private async send(envelope: ServerEnvelopeInit): Promise<void> {
    if (this.closed) throw runnerUnavailable("session closed");
    await this.outbound.push(envelope);
  }

  private awaitSingle(requestId: string): Promise<RunnerEnvelope> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(runnerUnavailable("session closed"));
        return;
      }
      this.pending.set(requestId, { deliver: resolve, fail: reject });
    });
  }

  private buildFs(): FileSystemOps {
    return {
      stat: async (path) => (await this.fileOp({ case: "stat", value: create(StatOpSchema, { path }) })).result
          .value as FileInfo,
      list: async (path, depth) =>
        ((await this.fileOp({ case: "list", value: create(ListOpSchema, { path, depth: depth ?? 1 }) })).result
          .value as { entries: DirEntry[] }).entries,
      remove: async (path, opts) => {
        await this.fileOp({
          case: "remove",
          value: create(RemoveOpSchema, { path, recursive: opts?.recursive ?? false }),
        });
      },
      rename: async (from, to) => {
        await this.fileOp({ case: "rename", value: create(RenameOpSchema, { from, to }) });
      },
      mkdir: async (path) => {
        await this.fileOp({ case: "mkdir", value: create(MkdirOpSchema, { path }) });
      },
      tempDir: async (prefix) =>
        (await this.fileOp({ case: "tempDir", value: create(TempDirOpSchema, { prefix: prefix ?? "" }) })).result
          .value as string,
      grep: async (pattern, opts) =>
        (await this.fileOp({
          case: "grep",
          value: create(GrepOpSchema, {
            pattern,
            path: opts?.path ?? "",
            glob: opts?.glob ?? "",
            maxResults: opts?.maxResults ?? 0,
          }),
        })).result.value as GrepResult,
      readFile: (path, opts) => this.readFile(path, opts?.offset ?? 0, opts?.limit ?? 0),
      writeFile: (path, data, opts) => this.writeFile(path, data, opts?.append ?? false),
    };
  }

  private async fileOp(op: MessageInitShape<typeof FileOpRequestSchema>["op"]): Promise<FileOpResponse> {
    const requestId = this.nextRequestId();
    const response = this.awaitSingle(requestId);
    await this.send({ requestId, payload: { case: "fileOp", value: create(FileOpRequestSchema, { op }) } });
    const env = await response;
    if (env.payload.case === "error") throw fromWireError(env.payload.value);
    // fileOpResponse 是唯一合法的成功分支（协议保证）
    return env.payload.value as FileOpResponse;
  }

  private async readFile(path: string, offset: number, limit: number): Promise<{ data: Uint8Array; totalSize: number }> {
    const requestId = this.nextRequestId();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    const finished = new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(runnerUnavailable("session closed"));
        return;
      }
      this.pending.set(requestId, {
        deliver: (env) => {
          if (env.payload.case === "error") {
            reject(fromWireError(env.payload.value));
            return;
          }
          if (env.payload.case !== "fileChunk") return;
          const chunk = env.payload.value;
          if (chunk.data.length > 0) chunks.push(chunk.data);
          totalSize = Number(chunk.totalSize);
          if (chunk.eof) {
            this.pending.delete(requestId);
            resolve();
          }
        },
        fail: reject,
      });
    });
    await this.send({
      requestId,
      payload: {
        case: "readFile",
        value: create(ReadFileRequestSchema, { path, offset: BigInt(offset), limit: BigInt(limit) }),
      },
    });
    await finished;
    return { data: concat(chunks), totalSize };
  }

  private async writeFile(path: string, data: Uint8Array, append: boolean): Promise<WriteFileResponse> {
    const requestId = this.nextRequestId();
    const response = this.awaitSingle(requestId);
    // 空文件也是合法写入：单 chunk + eof
    const total = data.length;
    let sent = 0;
    let isFirst = true;
    for (;;) {
      const slice = data.subarray(sent, sent + WRITE_CHUNK);
      sent += slice.length;
      const isLast = sent >= total;
      await this.send({
        requestId,
        payload: {
          case: "writeFile",
          value: create(WriteFileRequestSchema, {
            path: isFirst ? path : "", // 仅首个 chunk 携带 path
            data: slice,
            append: isFirst && append, // 仅首个 chunk 有意义
            eof: isLast,
          }),
        },
      });
      isFirst = false;
      if (isLast) break;
    }
    const env = await response;
    if (env.payload.case === "error") throw fromWireError(env.payload.value);
    return env.payload.value as WriteFileResponse;
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
