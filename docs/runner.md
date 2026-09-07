# Runner

> `crates/runner` — Rust native Execution Plane。
> 可执行文件和产品命令统一名为 `nova-runner`。
> 结构契约见 `repo-layout.md` §4.13，协议见 `proto.md`。

---

## 1. 定位

Runner 是独立的 Execution Plane，只执行已经做出的决策并报告事实。

**Runner 只认识**

- `ExecuteRequest`、`Execution`、`ExecutionEvent`
- Workspace、Process、Filesystem
- Sandbox、Resource Limit、Cancellation

**Runner 不认识**

- Conversation、User 业务模型、Prompt、Agent、Planning
- Task 业务含义、Retry policy、Scheduler
- Web API、SSE、Database

Runner 不决定下一步做什么，不根据退出码自动重试，也不投影 UI 事件。

---

## 2. 最终边界

Runner 相关只保留三个概念：

| 概念 | 位置 | 职责 |
|---|---|---|
| Runner | `crates/runner` | Rust native execution worker |
| Runner SDK | `packages/runner-sdk` | Node.js / TypeScript ↔ Rust 的 gRPC + Protobuf 技术桥梁 |
| Runner Module | `apps/agent-server/src/modules/runner` | Registry、调度、用户权限和生命周期 |

```text
Agent / TaskFlow
      │
      ▼
agent-server Runner Module
      │
      ▼
packages/runner-sdk
      │
      │ gRPC + Protobuf
      ▼
crates/runner
      │
      ▼
Execution Engine
      │
      ▼
OS / Workspace / Process / Sandbox
```

`nova-runner` 仅是 `crates/runner` 产生的 Rust binary / 产品命令，不在 Node.js
执行数据路径上。`packages/runner` 只是把各平台预构建 binary 放进 npm 可安装物并透传
CLI 参数，不提供第二套执行实现。

---

## 3. 真实 Remote Boundary

系统只有一种执行边界。`remote` 的含义是 RPC / process boundary，而不是必须跨机器。

开发、测试和生产中始终经过真实 Rust 进程、socket、Protobuf、gRPC streaming、
cancellation 和 timeout。不得增加第二条执行路径。

核心集成测试不能用 stdio、Node 进程执行、Runner 内部直调、内嵌或 mock execution
替代该边界。

---

## 4. 生产网络拓扑

Runner 安装在用户机器上，由 Runner 主动建立出站持久 gRPC 连接：

```text
user machine
  nova-runner
      │
      │ outbound persistent bidirectional gRPC
      ▼
agent-server / packages/runner-sdk
      │
      ▼
Runner Module / Registry
```

该拓扑不要求用户机器开放公网入站端口，可适应 NAT、Firewall、动态 IP、
公司/家庭网络、WSL 和 DevContainer。

连接是双向流：

- Runner → server：注册、心跳、状态、ExecutionEvent、文件操作结果
- server → Runner：ExecuteRequest、CancelRequest、文件操作请求、drain / shutdown

Runner SDK 负责消息关联和连接事实；Runner Module 负责是否接纳、如何登记、
选哪个 Runner 以及用户是否有权使用。

---

## 5. 目录结构

Runner 保持单 crate，用 Rust module 表达内部职责：

```text
crates/runner/
├── build.rs
└── src/
    ├── main.rs           # nova-runner daemon 入口
  ├── config.rs         # server / token / root / resource limits
    ├── connection.rs     # 出站 gRPC 连接、心跳、有界重连
    ├── protocol.rs       # Protobuf 转换与消息路由
    ├── execution/
    │   ├── mod.rs        # Execution 状态机
    │   ├── scheduler.rs  # 本 worker 的并发额度和排队
    │   └── stream.rs     # 输出分块和背压
    ├── process.rs         # spawn / kill / 进程组
    └── workspace/
        ├── mod.rs        # root 与路径边界
        ├── file.rs       # 文件操作
        └── grep.rs       # 跨平台结构化搜索原语
```

`execution/scheduler.rs` 只管理单 worker 内部的资源额度和背压，
不是 Control Plane 的 Runner Scheduler。

---

## 6. Execution 状态机

```text
ExecuteRequest
    │
    ▼
 queued ──(有额度)──► running ──► completed
    │                    │
    │                    ├──► timed_out
    │                    ├──► cancelled
    │                    └──► failed
    └──(队列满)──► BUSY
```

- 队列必须有上限，满时立即拒绝。
- `Started` 在进程创建成功后发出。
- `Output` 分开 stdout / stderr，传输 `bytes`。
- `Finished` 是每个已接纳 execution 的最后事件。
- `exit_code != 0` 仍是 `completed`，由 Agent / TaskFlow 解释。
- Runner 不对失败、超时或断连执行业务重试。

---

## 7. 输出与取消

| 关注点 | 契约 |
|---|---|
| 分块 | 按字节数或时间窗口聚合，避免逐字节 gRPC 事件 |
| stdout / stderr | 独立事件，不合并 |
| 编码 | 原始 `bytes`，解码在 Node.js 消费端 |
| 背压 | 出站流阻塞时暂停读取子进程 pipe |
| 输出上限 | 超限后停止转发并标记截断，进程继续到终态 |
| 取消 | 按 `execution_id` 终止进程组，不关闭整个 Runner 连接 |

Runner 断线时必须终止或明确接管已运行进程，不得留下孤儿进程。

---

## 8. Workspace 与安全边界

一个 Runner 进程只有一个在启动时确定的设备 root。Project 的 workspace 是该 root 下由用户
选择的工作目录；所有 cwd 和文件操作都必须：

1. 相对设备 root 解析。
2. 规范化 `.` / `..`。
3. 解析符号链接。
4. 确认最终路径仍在 root 内。

越界必须返回 `OUT_OF_WORKSPACE`。workspace 不存在时拒绝启动，不自动创建。

Project workspace 只作为 Agent 相对路径和命令的默认 `cwd`，不是额外的读取权限边界。Agent 可以
读取设备 root 内的 sibling 路径；大文件读取的行数、字节数和搜索结果上限属于资源保护，不得被
解释成读取 ACL。删除是独立的高风险操作，其审批语义由 Tool / Decision 拥有，Runner 仍负责拒绝
root 越界和根目录删除。删除和重命名不得跟随最后一级符号链接；删除链接只删除链接本身。重命名
目标已存在时返回 `EXISTS`，不隐式覆盖已有文件。

Agent 源码读取必须使用 Runner 侧的有界文本窗口：缺省 200 行，同时限制返回字节数；不得先把
整个文件读入 Runner 内存或传给 Node.js 后再切行。跨文件搜索逐行处理，达到结果上限并确认仍有
后续匹配后立即停止，不为精确计数继续遍历整个 workspace。

文件元数据、文本读取和搜索在连接路由循环之外执行，共用 4 个有界槽位；满时返回 `BUSY`，不得
无界排队。这样慢磁盘或大仓库搜索不会阻塞 Execute、Cancel、heartbeat、drain 和 shutdown 消息。

Sandbox 和 Resource Limit 是 Runner 领域概念。未实现的能力必须返回
`UNSUPPORTED`，不得静默忽略。

---

## 9. `nova-runner` 命令

`nova-runner` 只启动常驻 worker；所有 Execution 都从已建立的 gRPC 连接到达。
交互运行可直接传参，OS 后台托管应使用 TOML 配置文件；显式 CLI 值覆盖配置文件。

```bash
nova-runner \
  --server https://agent.example.com/runner-connect \
  --token <runner-token> \
  --workspace ./ \
  --max-concurrency 16 \
  --queue-size 64 \
  --default-timeout-ms 120000
```

```bash
nova-runner --config ~/.config/nova-runner/config.toml
```

```toml
server = "https://agent.example.com/runner-connect"
token = "<runner-token>"
workspace = "/home/user"
max_concurrency = 16
queue_size = 64
default_timeout_ms = 120000
```

- `--server` 和凭据是建立出站连接的必需配置，可来自 CLI 或 `--config`。
- 配置文件中未指定的字段使用 CLI 的同一缺省值；未知字段和无法解析的文件必须拒绝启动。
- Runner 启动后立即尝试连接；连接失败或断开后继续注册，重试间隔从 1 分钟按 2 倍递增，最大 10 分钟，最多尝试 1000 次。达到上限后进程退出并记录错误。
- token 只用于 Runner 连接身份；用户权限判定在 Runner Module。
- 日志可输出到终端或文件，但 stdio 不得成为 Execution transport。
- Rust binary 的安装和发布可以由 `packages/runner` 这个纯分发包完成，但它不得进入
  Node.js 运行时架构，也不得提供 Node.js 执行 fallback。

### 9.1 用户安装形态

连接可选项 `--connect-ip <IP>`（TOML 字段 `connect_ip`）覆盖 TCP 连接目标，
仅接受 IPv4/IPv6 地址，不接受域名或端口。端口仍取自 `--server`（默认 HTTP 80、HTTPS 443），
原 URL 的域名、路径、HTTP/2 authority 和 TLS 验证名称保持不变，不查询目标域名 DNS。
CLI 优先于 TOML；省略时维持系统 DNS 解析。指定 IP 失败时不回退 DNS，继续按原重连策略重试。
例如 `--server http://nova-grpc.8and1.cn --connect-ip 223.109.200.118`。
IP 变化需更新配置；此选项不需要修改容器 DNS 或 hosts。

- Windows Release 提供 `nova-runner-setup.exe`。安装器收集 server、token 和 workspace，
  写入当前用户可读的配置，注册用户登录计划任务并立即启动。
- Linux Release 提供 `nova-runner-linux-x64.tar.gz`、`SHA256SUMS` 和
  `install-runner.sh`。安装脚本按需通过 sudo 写入 binary、配置和 systemd system unit，
  但 unit 必须使用发起安装的普通用户运行 Runner，不得以 root 执行 workspace 操作。
  Linux x64 产物以 glibc 2.34 为最低运行时构建；不发布静态 musl 产物，避免其
  `getaddrinfo(AF_UNSPEC)` 在部分本地 DNS 的 A / AAAA 异常响应下丢弃有效 A 记录。
  GitHub Release 与 npm 包复用同一个 `x86_64-unknown-linux-gnu` 产物；发布前在
  Rocky Linux 9 中检查动态 libc 依赖并运行 `--help`，确保产物可在最低运行时启动。
- OS 托管负责开机/登录启动和进程异常拉起；Runner 自身仍是网络重连的唯一 owner。

---

## 10. 测试与验收

核心集成测试可以不启动完整 agent-server，但必须由 `packages/runner-sdk`
启动真实 gRPC 接入点，再启动真实 `nova-runner` Rust 进程主动连入。

核心链路的验收必须覆盖：

- 进程边界和真实 Protobuf 序列化
- 双向 gRPC streaming 与多 execution 消息关联
- stdout / stderr 背压和截断
- timeout 与 cancellation 确实终止进程组
- 断连不重放有副作用的请求
- workspace 越界和符号链接逃逸被拒绝
