# proto

> `proto/` — 跨进程唯一契约，TS 与 Rust 类型的共同生成源。
> 结构契约见 `repo-layout.md` §4.14。

---

## 1. 边界

| | `proto/` | `packages/protocol/` |
|---|---|---|
| 边界 | 进程边界（agent-server ↔ Runner） | 浏览器边界（web-ui ↔ agent-server） |
| 传输 | gRPC + Protobuf | HTTP + SSE + JSON |
| 跨语言 | 是（TS + Rust） | 否 |

**互不 import。** UI 要展示 Execution 输出时，由 agent-server 做 Projection。

---

## 2. 约束

| 约束 | 说明 |
|---|---|
| 禁止手工维护重复的 TS type 与 Rust struct | 全部由 codegen 产出 |
| 禁止 `everything.proto` | 按边界拆 3 个文件 |
| 禁止万能 `Message { type, subtype, metadata, payload }` | 用 `oneof` + typed message |
| 第一版只保留真正需要的 Event | 不预造几十种状态 |
| 保留 `sequence` / `event_id` | 为将来 Attach / Replay 留位，**第一版不实现 Event Store** |

**字段编号不复用。** 删字段用 `reserved`，不把编号让给新字段。

---

## 3. common.proto

```proto
syntax = "proto3";
package nova.common.v1;

import "google/protobuf/timestamp.proto";

enum ErrorCode {
  ERROR_CODE_UNSPECIFIED   = 0;
  ERROR_CODE_NOT_FOUND     = 1;
  ERROR_CODE_PERMISSION    = 2;
  ERROR_CODE_INVALID       = 3;
  ERROR_CODE_OUT_OF_WORKSPACE = 4;
  ERROR_CODE_TOO_LARGE     = 5;
  ERROR_CODE_TIMEOUT       = 6;
  ERROR_CODE_CANCELLED     = 7;
  ERROR_CODE_UNSUPPORTED   = 8;   // §7 sandbox / 资源限制
  ERROR_CODE_BUSY          = 9;   // 并发上限，客户端可重试
  ERROR_CODE_IO            = 10;
  ERROR_CODE_IS_DIR        = 11;  // 对应 FsErrorCode.IS_DIR
  ERROR_CODE_NOT_DIR       = 12;  // 对应 FsErrorCode.NOT_DIR
  ERROR_CODE_EXISTS        = 13;  // 对应 FsErrorCode.EXISTS
  ERROR_CODE_SPAWN_FAILED  = 14;  // 对应 ExecErrorCode.SPAWN_FAILED
}

message Error {
  ErrorCode code    = 1;
  string    message = 2;
}
```

只有一个 enum 和一个 message。**没有** `Status` / `Metadata` / `Pagination` / `Empty` ——
gRPC 自带 status，proto3 自带 `google.protobuf.Empty`。

---

## 4. execution.proto

```proto
syntax = "proto3";
package nova.execution.v1;

import "google/protobuf/timestamp.proto";
import "common.proto";

// 本文件只定义 Execution 与 Filesystem 消息。
// 它们由 runner.proto 的 RunnerConnection.Connect 双向流承载。
```

Execution 和 Filesystem 不对 Runner 开放入站 RPC。文件元数据操作
（stat / list / remove / rename / mkdir / tempdir）共用 `FileOp` 的 `oneof`；
读写使用独立分块消息，但仍复用 `Connect` 流。

> 这里的 `oneof` 是 **typed message 的联合**，不是被禁止的 `type + JSON payload`。
> 每个分支都有自己的强类型 message。

### 4.1 执行面

```proto
message ExecuteRequest {
  string   execution_id = 1;          // 客户端生成，幂等键
  string   command      = 2;
  repeated string args  = 3;
  string   cwd          = 4;          // 相对 workspace root，空 = root
  map<string, string> env = 5;
  uint32   timeout_ms   = 6;          // 0 = 用 Runner 默认值
  bytes    stdin        = 7;

  ResourceLimits resources = 8;       // §7：未实现则报 UNSUPPORTED
  Sandbox        sandbox   = 9;       // 同上
}

message ResourceLimits { uint32 cpu_millis = 1; uint64 memory_bytes = 2; }
message Sandbox        { bool network = 1; bool readonly_fs = 2; }

message ExecutionEvent {
  string  execution_id = 1;
  uint64  sequence     = 2;           // 从 1 递增，同一 execution 内连续
  google.protobuf.Timestamp ts = 3;

  oneof event {
    Started  started  = 10;
    Output   output   = 11;
    Finished finished = 12;
  }
}

message Started  { int32 pid = 1; }
message Output   { OutputStream stream = 1; bytes data = 2; }
message Finished {
  ExecutionStatus  status    = 1;
  int32            exit_code = 2;     // 仅 COMPLETED 有意义
  nova.common.v1.Error error = 3;     // 仅非 COMPLETED 有意义
  uint64           duration_ms = 4;
}

enum OutputStream { OUTPUT_STREAM_UNSPECIFIED = 0; OUTPUT_STREAM_STDOUT = 1; OUTPUT_STREAM_STDERR = 2; }

enum ExecutionStatus {
  EXECUTION_STATUS_UNSPECIFIED = 0;
  EXECUTION_STATUS_COMPLETED   = 1;   // 进程正常退出（exit_code 可能非 0）
  EXECUTION_STATUS_FAILED      = 2;   // 无法启动 / 被信号杀死 / IO 错误
  EXECUTION_STATUS_CANCELLED   = 3;
  EXECUTION_STATUS_TIMED_OUT   = 4;
}

message CancelRequest  { string execution_id = 1; }
message CancelResponse { bool found = 1; }
```

**三种事件，一个终态 message。**

idea.md §12 列了 7 种 Event（Started / Output / Progress / Artifact / Completed / Failed / Cancelled）。
收敛理由：

| 原 | 现 | 理由 |
|---|---|---|
| `Completed` / `Failed` / `Cancelled` / `TimedOut` | `Finished` + `ExecutionStatus` | 四个终态语义相同，只是结果不同。分成四种 message 会让每个消费方写四个分支 |
| `Progress` | 删除 | 进程执行没有进度概念。真需要进度的是 agent 的 todo 列表，那在 `tools` 层 |
| `Artifact` | 推迟 | Phase 1 无 artifact 存储。见 §7 |

**`exit_code != 0` 是 `COMPLETED` 不是 `FAILED`。** 命令失败是正常业务结果，
要让模型看到 exit code 自己判断；`FAILED` 专指"没能正常跑起来"。

### 4.2 文件面

```proto
message ReadFileRequest {
  string path   = 1;
  uint64 offset = 2;      // 字节偏移
  uint64 limit  = 3;      // 0 = 到文件尾
}
message FileChunk { bytes data = 1; bool eof = 2; uint64 total_size = 3; }

message WriteFileRequest {
  string path   = 1;      // 仅首个 chunk 有效
  bytes  data   = 2;
  bool   append = 3;      // 仅首个 chunk 有效
  bool   eof    = 4;      // 终止标记：最后一个 chunk（双向流没有流结束信号）
}
message WriteFileResponse { uint64 bytes_written = 1; bool created = 2; }

message FileOpRequest {
  oneof op {
    StatOp    stat    = 1;
    ListOp    list    = 2;
    RemoveOp  remove  = 3;
    RenameOp  rename  = 4;
    MkdirOp   mkdir   = 5;
    TempDirOp temp_dir = 6;
    GrepOp    grep    = 7;
  }
}

message StatOp    { string path = 1; }
message ListOp    { string path = 1; uint32 depth = 2; }
message RemoveOp  { string path = 1; bool recursive = 2; }
message RenameOp  { string from = 1; string to = 2; }
message MkdirOp   { string path = 1; }
message TempDirOp { string prefix = 1; }
message GrepOp    { string pattern = 1; string path = 2; string glob = 3; uint32 max_results = 4; }

message FileOpResponse {
  oneof result {
    FileInfo    info     = 1;
    ListResult  list     = 2;
    google.protobuf.Empty ok = 3;   // remove / rename / mkdir
    string      path     = 4;       // temp_dir
    GrepResult  grep     = 5;
  }
}

message FileInfo   { string path = 1; FileKind kind = 2; uint64 size = 3; int64 mtime = 4; }
message ListResult { repeated DirEntry entries = 1; }
message DirEntry   { string name = 1; FileKind kind = 2; }
message GrepResult { repeated GrepMatch matches = 1; uint32 total = 2; bool truncated = 3; }
message GrepMatch  { string file = 1; uint32 line = 2; string text = 3; }

enum FileKind { FILE_KIND_UNSPECIFIED = 0; FILE_KIND_FILE = 1; FILE_KIND_DIR = 2; FILE_KIND_SYMLINK = 3; }
```

**`GrepOp` 放在文件面**而不是让 `grep` tool 拼 shell：跨平台（Windows 无 `grep`）、
转义安全、结果结构化。见 `tools.md` §3。

**错误分两级**：

- **连接级错误**（Connect 流建立被拒、传输层失效）走 gRPC status。
- **流内请求级错误**（文件操作失败等）走 `RunnerEnvelope` 的
  `nova.common.v1.Error error` 分支（§5），用 `request_id` 关联回原请求。
  Execute 的拒绝（BUSY / INVALID 等）经 `Finished.error` 带内上报。

文件操作不设响应体 `error` 字段——那会让每个调用点都要检查两处；
流内失败统一走 envelope Error 分支，成功才发对应的 Response / Chunk。

---

## 5. runner.proto

Runner 主动建立的持久双向 gRPC 流。控制消息与 Execution 消息复用同一连接，
用户机器不开放入站执行端口。

```proto
syntax = "proto3";
package nova.runner.v1;

import "common.proto";
import "execution.proto";

service RunnerConnection {
  rpc Connect(stream RunnerEnvelope) returns (stream ServerEnvelope);
}

message RunnerEnvelope {
  string request_id = 1;
  oneof payload {
    Register register = 2;
    Heartbeat heartbeat = 3;
    nova.execution.v1.ExecutionEvent execution_event = 4;
    nova.execution.v1.FileOpResponse file_op_response = 5;
    nova.execution.v1.FileChunk file_chunk = 6;
    nova.execution.v1.WriteFileResponse write_file_response = 7;
    nova.execution.v1.CancelResponse cancel_response = 8;
    nova.common.v1.Error error = 9;   // 流内请求级错误（文件操作失败等），request_id 关联
  }
}

message ServerEnvelope {
  string request_id = 1;
  oneof payload {
    Accepted accepted = 2;
    nova.execution.v1.ExecuteRequest execute = 3;
    nova.execution.v1.CancelRequest cancel = 4;
    nova.execution.v1.FileOpRequest file_op = 5;
    Drain drain = 6;
    Shutdown shutdown = 7;
    nova.execution.v1.ReadFileRequest read_file = 8;
    nova.execution.v1.WriteFileRequest write_file = 9;
  }
}

message Register {
  string runner_id = 1;
  string version   = 2;
  string platform  = 3;             // "linux-x64" / "darwin-arm64" / "windows-x64"
  repeated string capabilities = 4; // "git" "node" "docker" ...
  uint32 cpu_count     = 5;
  uint64 memory_bytes  = 6;
  uint32 max_concurrency = 7;
  map<string, string> labels = 8;
  string root = 9;                // Runner 设备可访问的根目录
}
message Accepted  { uint32 heartbeat_interval_ms = 1; string generation = 2; }
message Heartbeat { string runner_id = 1; RunnerState state = 2; uint32 running = 3; }
message Drain     { string reason = 1; }
message Shutdown  { string reason = 1; }

enum RunnerState {
  RUNNER_STATE_UNSPECIFIED = 0;
  RUNNER_STATE_READY    = 1;
  RUNNER_STATE_BUSY     = 2;
  RUNNER_STATE_DRAINING = 3;
}
```

`request_id` 关联文件操作等请求/响应，`execution_id` 关联 Execution 事件。
`RunnerEnvelope.error` 承载流内请求级错误（见 §4.2）：server 发出
`read_file` / `write_file` / `file_op` 等请求后，Runner 若失败不发对应 Response，
而是发 `Error`（同一 `request_id`），server 据此解析为对应请求的失败。
Execute 的拒绝（`BUSY` / 幂等键冲突等）不走 Error 分支：Runner 对该
`execution_id` 直接发一条 `Finished`（`FAILED` + `error`）事件收尾，
保持"每个 execution 的事件流必以 Finished 结束"的单一形状。
`DISCONNECTED` 不在协议枚举里，由 server Runner Module 根据连接和心跳推导。

---

## 6. Codegen

| 目标 | 工具 | 产物 |
|---|---|---|
| TypeScript | `@bufbuild/protobuf` + `@connectrpc/connect` | `packages/runner-sdk/src/gen/` |
| Rust | `tonic-build`（`build.rs`） | `OUT_DIR`，`include_proto!` 引入 |

TypeScript 生成产物随协议源一起入库。协议变化后运行 `pnpm proto:generate` 并提交
`packages/runner-sdk/src/gen/` 的更新；禁止手工编辑该目录。这样依赖 `runner-sdk` 源码的
应用可在干净检出中直接完成类型检查。

`buf lint` + `buf breaking` 进 CI，防止意外破坏兼容性。

---

## 7. 保留但未实现的字段

`ResourceLimits` 与 `Sandbox` 在 Phase 1 **不实现**（`repo-layout.md` §6.8）。

**硬规矩：收到这两个字段且非默认值时，必须返回 `ERROR_CODE_UNSUPPORTED`，不得静默忽略。**

静默忽略意味着调用方以为自己开了沙箱其实没有 —— 这比明确不支持危险得多。

`Artifact` Phase 1 不进 proto。需要产出文件时，tool 让命令写到 workspace 里，
再用 `ReadFile` 取。等真的出现"大二进制不该进消息体"的场景再加 —— 那时才知道该配什么存储。
