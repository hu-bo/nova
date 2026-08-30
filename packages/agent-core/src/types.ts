// 核心类型。契约见 docs/agent-core.md §2/§3（Decision 见 §6）。
import type { ModelRef, StreamFn, ThinkingLevel } from "@nova/model-adapters";
import type { AgentHooks } from "./loop/hooks.js";
import type { SessionStorage } from "./session/storage.js";
import type { EntryId } from "./session/entry.js";
import type { CompactionResult } from "./context/compaction.js";
import type { ZodType } from "./tool-schema.js";

// §3.1 Message / Block —— Agent 内部对话表示，不与 packages/protocol 的 UI 类型共享定义
export interface Message {
  id: string;
  role: "user" | "assistant";
  blocks: Block[];
  createdAt: number;
}
export type Block =
  | { type: "text"; text: string }
  | {
      type: "thinking";
      text: string;
      signature?: string;
      data?: { format: "deepseek" } | { format: "minimax"; details: unknown[] };
    }
  | { type: "tool_call"; callId: string; name: string; args: unknown }
  | { type: "tool_result"; callId: string; status: "ok" | "error"; content: ContentPart[] }
  | { type: "image"; mimeType: string; data: string };
export type ContentPart = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

// §3.2 Tool 与结果
export type Risk = "none" | "read" | "write" | "exec";
export interface ToolCall {
  callId: string;
  name: string;
  args: unknown;
}
export interface JSONSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  enum?: unknown[];
  [key: string]: unknown;
}
export interface AgentTool<A = unknown, D = unknown> {
  name: string;
  description: string;
  schema: ZodType<A>;
  executionMode?: "parallel" | "sequential";
  risk?: Risk;
  requiresContext?: boolean;
  execute(args: A, ctx?: ToolContext): Promise<AgentToolResult<D>>;
}
export interface AgentToolResult<D = unknown> {
  status: "ok" | "error";
  content: ContentPart[];
  details: D;
  usage?: Usage;
  terminate?: boolean;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ContextUsage {
  inputTokens: number | null;
  contextWindow: number;
}

export type AgentTaskResult<T = unknown> =
  | { ok: true; summary: string; data?: T }
  | {
      ok: false;
      summary: string;
      error: { code: string; message: string; retryable?: boolean };
    };

// §3.3 Result 与错误契约 —— StreamFn 与 ToolContext.fs/exec 不得 throw，一律走 Result
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// §3.4 ToolContext —— tool 不依赖 runner-sdk，只接收这个窄接口
export interface ToolContext {
  fs: FileSystem;
  exec(cmd: string, opts?: ExecOptions): Promise<Result<ExecOutput, ExecError>>;
  signal: AbortSignal;
  cwd: string;
}
export interface FileSystem {
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<Result<TextFile, FsError>>;
  readBytes(path: string): Promise<Result<Uint8Array, FsError>>;
  write(path: string, content: string, opts?: { append?: boolean }): Promise<Result<void, FsError>>;
  rename(from: string, to: string): Promise<Result<void, FsError>>;
  remove(path: string, opts?: { recursive?: boolean }): Promise<Result<void, FsError>>;
  mkdir(path: string): Promise<Result<void, FsError>>;
  list(path: string): Promise<Result<DirEntry[], FsError>>;
  stat(path: string): Promise<Result<FileInfo, FsError>>; // 不存在 → error(NOT_FOUND)
  tempDir(prefix?: string): Promise<Result<string, FsError>>;
  // proto.md §4.2 GrepOp：Runner 侧结构化搜索原语，tools.md §3 `grep` 工具的落点，不拼 shell
  grep(pattern: string, opts?: GrepOptions): Promise<Result<GrepMatch[], FsError>>;
}
export interface GrepOptions {
  path?: string;
  glob?: string;
  maxResults?: number;
}
export interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

export interface TextFile {
  text: string;
  totalLines: number;
  truncated: boolean;
}
export interface FileInfo {
  path: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
}
export interface DirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
}

export interface ExecOptions {
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  onOutput?: (chunk: OutputChunk) => void;
  signal?: AbortSignal;
}
export interface ExecOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}
export type OutputChunk = { stream: "stdout" | "stderr"; text: string };

export type FsErrorCode =
  "NOT_FOUND" | "PERMISSION" | "IS_DIR" | "NOT_DIR" | "EXISTS" | "OUT_OF_WORKSPACE" | "TOO_LARGE" | "IO";
export type ExecErrorCode = "TIMEOUT" | "CANCELLED" | "SPAWN_FAILED" | "RUNNER_UNAVAILABLE" | "IO";
export type FsError = { code: FsErrorCode; message: string; path?: string };
export type ExecError = { code: ExecErrorCode; message: string; exitCode?: number };

// §6 Decision —— 审批与反问共用一套挂起 → 发请求 → 等人类 → 恢复
export type CodeChange = {
  path: string;
  oldText: string;
  newText: string;
};
export type DecisionRequest =
  | {
      kind: "approval";
      decisionId: string;
      callId: string;
      toolName: string;
      args: unknown;
      risk: Risk;
      codeChanges?: CodeChange[];
    }
  | { kind: "question"; decisionId: string; question: string; options: string[]; multiSelect: boolean };
export type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason?: string }
  | { kind: "question"; answers: string[] };
export type Decide = (req: DecisionRequest, signal: AbortSignal) => Promise<DecisionResponse>;
export type ApprovalMode = "auto" | "ask" | "deny";
export interface ApprovalPolicy {
  default: ApprovalMode;
  byRisk?: Partial<Record<Risk, ApprovalMode>>;
  byTool?: Record<string, ApprovalMode>;
}

// §7 三条队列 —— 消息缓冲，不是调度器
export type QueueName = "steering" | "followUp" | "nextRun";

// §9.1 Plan State（TODO）—— 唯一一份不受压缩影响的进度状态
export interface Todo {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  note?: string;
}
export interface TodoState {
  items: Todo[];
  updatedAt: number;
}

// §11 AgentEvent —— 对外唯一的观测面
export type AgentEvent =
  | { type: "message.start"; messageId: string; role: "assistant" }
  | { type: "block.start"; messageId: string; index: number; blockType: Block["type"] }
  | { type: "block.delta"; messageId: string; index: number; delta: string }
  | { type: "block.end"; messageId: string; index: number; block: Block }
  | { type: "message.end"; messageId: string; stopReason: StopReason }
  | { type: "tool.start"; callId: string; name: string; args: unknown }
  | { type: "tool.end"; callId: string; status: "ok" | "error"; details: unknown }
  | { type: "decision.requested"; request: DecisionRequest }
  | { type: "decision.resolved"; decisionId: string }
  | { type: "todo.updated"; items: Todo[] }
  | { type: "context.updated"; usage: ContextUsage }
  | { type: "run.end"; runId: string; stopReason: StopReason; usage: Usage }
  | { type: "error"; code: string; message: string };

export type StopReason =
  "done" | "max_tokens" | "repetition_detected" | "terminate" | "max_turns" | "aborted" | "error";

// §2 对外 API 面
export interface PromptAsset {
  name: string;
  content: string;
}

// stream / ctx / storage / decide 四个注入点 = 本包全部的外部世界；只有 ctx 可缺省（Chat 模式，§1.1）
export interface AgentConfig {
  model: ModelRef;
  stream: StreamFn;
  tools: AgentTool[];
  ctx?: ToolContext;
  storage: SessionStorage;
  decide: Decide;
  sessionId?: string; // 缺省自动生成；resume / 重建场景必须传入原 session
  hooks?: AgentHooks;
  approvalPolicy?: ApprovalPolicy;
  userId?: string; // 缺省 "local"
  systemPrompt?: PromptAsset[];
  maxTurns?: number; // 缺省 100
  toolConcurrency?: number; // 缺省 8（§4.2）
  subAgent?: { maxConcurrent?: number; maxDepth?: number }; // 缺省 4 / 1（§10）
}

export interface AgentState {
  isStreaming: boolean;
  streamingMessage: Message | null;
  pendingToolCalls: ToolCall[];
  pendingDecision: DecisionRequest | null;
  model: string;
  thinkingLevel: ThinkingLevel;
  activeTools: string[];
  errorMessage: string | null;
}

export interface RunResult {
  runId: string;
  stopReason: StopReason;
  message: Message | null; // 最后一条 assistant message
  usage: Usage;
  output?: AgentTaskResult;
  errorMessage?: string;
}

export interface Agent {
  readonly sessionId: string;
  prompt(input: string | ContentPart[], options?: { thinkingLevel?: ThinkingLevel }): Promise<RunResult>;
  steer(msg: string): void; // 运行中插话，当前 tool batch 跑完后注入
  followUp(msg: string): void; // agent 准备停下时注入，让它继续
  nextRun(msg: string): void; // 排到下一个独立 run
  abort(): Promise<void>;
  compact(opts?: { instruction?: string }): Promise<CompactionResult>;
  contextUsage(): Promise<ContextUsage>;
  fork(entryId: EntryId): Promise<Agent>;
  resume(): Promise<void>; // 崩溃 / 重启后依据 Record 续跑
  readonly state: AgentState;
  subscribe(listener: (event: AgentEvent) => void): () => void;
}
