# Runner 功能点与错误 / 卡死处理


---

## 1. 模块地图

| 模块 | 职责 | 关键常量 / 默认值 |
|---|---|---|
| `main.rs` | 日志初始化、配置装载、shutdown 信号（SIGTERM / Ctrl-C） | EnvFilter 默认 `info` |
| `config.rs` | CLI + TOML 配置合并与启动期校验 | `max_concurrency` = CPU 数（兜底 4）；`queue_size` = 4×并发；`default_timeout_ms` = **12 000（代码值，见 §6）** |
| `connection.rs` | 出站 gRPC 连接、Register / Accepted / Heartbeat、指数退避重连 | 连接超时 10 s；keepalive 60 s / PING 超时 20 s；退避 1 s→10 min；最多 1 000 次；出站缓冲 64 |
| `protocol.rs` | Connect 流内消息路由（Execute / Cancel / FileOp / ReadFile / WriteFile / Drain / Shutdown） | 文件操作并发槽 4；ReadFile 分块 256 KB |
| `execution/mod.rs` | 执行状态机、幂等注册表、超时 / 取消 / 清理主循环 | 单次执行输出上限 10 MB；清理宽限 1 s |
| `execution/scheduler.rs` | 双信号量并发与排队 | admission = 并发+队列；running = 并发 |
| `execution/stream.rs` | stdout / stderr 分块读取与背压 | 8 KB 或 50 ms 一块；通道容量 2 |
| `process.rs` | spawn、stdin 注入、跨平台杀进程树 | Unix 进程组 SIGKILL；Windows Job Object |
| `workspace/mod.rs` | 路径解析与越界拒绝（含符号链接） | — |
| `workspace/file.rs` | stat / list / remove / rename / mkdir / temp_dir / read_text / read_range / WriteHandle | list 深度 ≤8、条目 ≤10 000；read_text 默认 200 行 / 256 KB，上限 2 000 行 / 1 MB |
| `workspace/grep.rs` | 内置结构化搜索（`ignore` + `regex`，不起进程） | 结果默认 100 / 硬上限 1 000；单行上限 1 MB |
| `pb.rs` / `build.rs` | vendored protoc 生成 gRPC 绑定（仅 client 侧） | 产物在 `OUT_DIR`，不手工编辑 |

---

## 2. 功能点清单

### 2.1 启动与配置

- CLI 参数与 TOML 文件双来源，**显式 CLI 值覆盖文件值**；TOML `deny_unknown_fields`，未知字段直接拒绝启动。
- `server`、`token` 必填，缺失时以明确错误信息拒绝启动（指向 docs/runner.md §9）。
- `workspace` 必须已存在，**绝不自动创建**；未指定时取当前目录。
- `runner_id` 缺省由 `runner-{os}-{hostname}-{workspace 的 FNV 哈希}` 派生，同机同目录重启保持稳定。
- `connect_ip` 支持"域名不变、只改 TCP 目标 IP"的连接方式：仅重写 connector 层 URI，HTTP/2 authority 与 TLS 主机名校验仍用原始域名（`connection.rs::connect_channel`，有专项测试）。

### 2.2 连接生命周期

- Runner **只出站**连接 agent-server 的双向 gRPC 流 `RunnerConnection.Connect`，用户机器不开入站端口。
- 注册：首个出站 envelope 为 `Register`（runner_id、版本、平台、CPU 数、并发上限、workspace 路径），token 走 `authorization: Bearer` 元数据；**首个入站 envelope 必须是 `Accepted`**，否则整个连接按失败处理。
- 心跳：按 `Accepted.heartbeat_interval_ms` 周期上报状态（`Draining` > `Busy` > `Ready` 优先级）与 `running` 计数；间隔下限钳制 100 ms，防服务端下发 0 导致空转。
- Drain：收到 `Drain` 后置位 draining，新 Execute 一律拒绝 `BUSY`，存量执行不受影响；心跳状态同步变为 `Draining`。
- Shutdown：收到 `Shutdown` 后 drain + `cancel_all()`（运行中的杀进程组，排队中的直接取消），结束会话；进程按正常重连逻辑待命（shutdown 信号才退出）。

### 2.3 重连与断连收口

- 会话结束（对端关流）或连接失败都会**先 `cancel_all()` 再重连**——断连即取消一切在途执行，绝不跨连接重放（runner.md §7）。
- 指数退避：1 s 起步、每次 ×2、封顶 10 min；一次成功注册后的断开会**重置**退避与计数，不把旧故障带入下一次。
- 尝试次数上限 1 000，超过后进程以错误退出（交给外部守护重启）。
- 连接错误按 error chain 文本分类打日志：`dns_resolution_error` / `transport_h2_error` / `stream_send_error` / `connect_or_protocol_error`，便于排障归因。

### 2.4 命令执行状态机

- 状态机：`queued → running → {completed, timed_out, cancelled, failed}`（runner.md §6）。
- `execution_id` 是幂等键：在途重复提交返回 `BUSY`；已结束的 id 返回 `INVALID`（Phase 1 无 Event Store，不可重放）。admit 后因容量拒绝的路径会 `abandon` 掉该 id，保持可重试。
- 事件序列：`Started{pid}` → 若干 `Output{stream, data}` → 恰好一个终态 `Finished{status, exit_code, error, duration_ms}`，`sequence` 从 1 严格递增。
- `command` 是可执行文件路径而非 shell 命令行（拼进 command 字段会 `SPAWN_FAILED`，有专项测试）；`cwd` 为空取 workspace 根，否则先过越界解析；`env` 是**叠加**在 Runner 自身环境之上（空 map 不会剥掉 PATH）；`stdin` 由独立任务写入后关闭，不阻塞主流程。
- `timeout_ms = 0` 表示使用 Runner 默认超时。
- `exit_code` 仅在 `Completed` 有意义；被外部信号杀死（非 Runner 发起）时 `code()` 为 None，Phase 1 不建模为独立状态，按 `Completed / exit_code = -1` 上报。

### 2.5 并发调度与排队

- 双信号量模型（`scheduler.rs`）：
  - `admission`（容量 = max_concurrency + queue_size）：非阻塞闸门，满员**立即** `BUSY`，队列绝不无界增长；
  - `running`（容量 = max_concurrency）：await 获取，**等待本身就是 queued 状态**。
- 排队期间可被取消：`wait_for_running_slot` 与 cancel 信号 select，取消的排队执行不会 spawn 进程，直接终态 `Cancelled`。
- 心跳的 `running` / `is_busy` 直接由信号量余量推导，无独立记账。

### 2.6 输出流式与背压

- stdout / stderr **分流不合并**，各自一个 reader 任务汇入同一有界通道（容量 2——这是背压旋钮，不是缓冲）。
- 分块规则：满 8 KB 立即发；不足 8 KB 时 50 ms 定时冲刷；EOF 后冲刷残余。
- gRPC 流写阻塞时，`send().await` 挂起 → reader 停止从子进程 pipe 拉数据 → **不在内存里堆积**（runner.md §5）。
- 单次执行输出转发上限 10 MB：超限后停止转发但**继续 drain**（防 pipe 写满卡死子进程），进程跑完为止，终态附带 `TOO_LARGE` 说明。

### 2.7 取消

- `Cancel` = `Notify` + `AtomicBool`：先注册 `Notified` 再查标志位，规避 missed-wakeup 竞态。
- 三个触发源：服务端 `Cancel(execution_id)`（返回 `found`）、断连 / Shutdown 的 `cancel_all()`、事件流被 drop（消费端消失等价取消）。
- 取消动的是**进程树**：Unix 对进程组发 SIGKILL（spawn 时 `process_group(0)`）；Windows 用带 `KILL_ON_JOB_CLOSE` 的 Job Object 整树终止。取消测试验收的是"进程真的死了"，不是 API 返回了。

### 2.8 文件操作（FileOp）

- 单请求 oneof：`Stat / List / Remove / Rename / Mkdir / TempDir / Grep / ReadText`。
- 同步文件 IO 放进 `spawn_blocking`，并发槽 4，**满员立即 `BUSY`** 而非排队。
- `List`：深度 0 按 1 处理，>8 拒绝 `INVALID`；条目 >10 000 拒绝 `TOO_LARGE`；结果按文件名排序，路径统一正斜杠相对路径。
- `Remove / Rename` 走 `resolve_entry`（见 §2.10）：删除符号链接不会删掉链接目标；rename 目标已存在返回 `EXISTS`，不覆盖；workspace 根本身禁止删除 / 改名。
- `TempDir` 建在 `{root}/.nova-tmp/` 内并 `keep()`，返回相对路径——保证后续读写请求都能通过 workspace 解析。
- `ReadText`：按行窗口读取（起始行 + 行数 + 字节上限），默认 200 行 / 256 KB，硬上限 2 000 行 / 1 MB；单行超长只截取不撑爆内存（`read_bounded_line`）；前 8 KB 探测 NUL / 非法 UTF-8，二进制文件拒绝 `INVALID`；`total_lines` 仅在自然读到 EOF 时给出。

### 2.9 文件流式读写（ReadFile / WriteFile）

- `ReadFile`：按 `offset / limit`（0 = 到文件尾）读字节区间，以 256 KB `FileChunk` 分块回传，最后一块 `eof = true`，每块携带 `total_size`；offset 越界返回空块 + eof。
- `WriteFile`：多 chunk 请求按 `request_id` 关联到一个 `WriteHandle`；首 chunk 必须带 `path`（否则 `INVALID`），自动创建父目录，`append` 决定追加或截断；`eof` chunk 收尾并回 `WriteFileResponse{bytes_written, created}`；中途出错即移除句柄并回 in-band 错误。

### 2.10 Workspace 安全边界

- 启动时把 root canonicalize 一次，之后所有路径操作先过 `Workspace::resolve`：
  1. 相对路径拼到 root；2. 词法归一化 `.` / `..`（不触盘）；3. canonicalize **最长已存在祖先**（这一步解析符号链接，含"叶子尚不存在的新文件"场景）；4. 拼回不存在尾巴；5. `starts_with(root)` 否则 `OUT_OF_WORKSPACE`。第 3 步不能省，否则指向外部的符号链接可越狱（runner.md §6）。
- `resolve_entry`：只 canonicalize 父目录、保留最终目录项不跟随——破坏性操作（remove / rename）必须用它，否则"删链接"会变成"删链接目标"。
- 返回给客户端的路径一律是相对 root 的正斜杠形式（`relative_string`），跨平台稳定。

### 2.11 内置 grep

- 唯一起进程之外的"具体命令"例外（runner.md §7）：`ignore::WalkBuilder` 遍历（尊重 `.gitignore`），`regex::bytes` 逐行匹配，可选 glob 过滤，全程无 shell、无转义问题。
- pattern / glob 非法返回 `INVALID`；结果超过 `max_results` 即停止收集并置 `truncated`；单行超 1 MB 置 incomplete；含 NUL 的文件按二进制跳过；打不开的文件静默跳过。

---

## 3. 错误处理模型

### 3.1 单一错误词汇

全 crate 复用 wire 层 `nova.common.v1.ErrorCode`（`error.rs`），**不另造平行 Rust 枚举**。内部统一为 `RunnerError { code, message }`，出口一步 `into_wire()`。`std::io::Error` 有兜底映射（NotFound→NOT_FOUND、PermissionDenied→PERMISSION、AlreadyExists→EXISTS、IsADirectory→IS_DIR、NotADirectory→NOT_DIR、其余→IO），但"更清楚上下文"的调用点必须显式指定错误码。

### 3.2 四条错误通道

| 层 | 通道 | 行为 |
|---|---|---|
| 启动期 | `ConfigError`（thiserror）→ stderr | `eprintln!("nova-runner: {err}")` + `exit(1)`——配置失败是**预期拒绝，不是 panic** |
| 连接层 | `anyhow::Error` | 记 `error_chain` + `category` 分类日志 → 指数退避重连；连续 1 000 次失败进程退出 |
| 请求级（文件面 / Cancel） | **in-band** `RunnerEnvelope.error`，按 `request_id` 关联 | 单个请求失败不影响连接；连错误都发不出去时（outbound 已关）升级为 `Status::unavailable` 结束会话、走重连 |
| 执行面 | **in-band** 终态 `Finished` 事件 | 只有 admission（第一步）能以事件形式拒绝（单发 `Finished{Failed}`，含 BUSY / INVALID / UNSUPPORTED）；**流一旦开始，spawn 失败、超时、取消、截断全部作为终态 `Finished` 上报，绝不作为 gRPC 流错误**（proto.md §4：Finished 必发且是流最后一个事件） |

### 3.3 错误码与触发场景

| ErrorCode | 触发点 |
|---|---|
| `OUT_OF_WORKSPACE` | 路径解析越界 / 符号链接逃逸 |
| `INVALID` | 重复使用已结束的 execution_id；ReadText 行数 / 字节超硬上限；list 深度超限；非 UTF-8 文本；grep pattern / glob 非法；WriteFile 首 chunk 缺 path；删除 / 改名 workspace 根；意外收到的服务端 envelope |
| `BUSY` | execution_id 在途重复提交；admission 满（并发+队列）；文件操作并发槽满；Drain 状态下新 Execute |
| `UNSUPPORTED` | Phase 1 未实现的 `ResourceLimits`（cpu_millis / memory_bytes 非 0）与 `Sandbox`（network / readonly_fs） |
| `SPAWN_FAILED` | 子进程无法启动（命令不存在、把命令行塞进 command 字段等），不发 `Started`，直接终态 `Finished{Failed}` |
| `TIMEOUT` | 执行超时被杀，终态 `TimedOut` |
| `CANCELLED` | 主动取消 / 排队中取消 / 消费端 drop，终态 `Cancelled` |
| `TOO_LARGE` | 输出转发超 10 MB；清理宽限内输出未 drain 完；list 条目超 10 000 |
| `IO` | `child.wait()` 失败等无结果兜底（"execution task ended without a result"）；文件操作任务失败；io 兜底映射 |
| `NOT_FOUND` / `PERMISSION` / `EXISTS` / `IS_DIR` / `NOT_DIR` | 文件系统错误经 io 映射或显式指定（如 rename 目标已存在） |

### 3.4 非致命错误降级为结构化日志

以下错误**不打断执行、不断连接**，只按 `category` 字段打日志（便于统一检索）：

| category | 场景 | 级别 |
|---|---|---|
| `process_kill_error` | Unix 杀进程组失败且非 ESRCH（ESRCH = 组已空，正常竞态，静默） | warn |
| `process_stdin_error` | stdin 写入 / 关闭失败（进程可能已退出） | warn |
| `process_error` | `child.wait()` 失败 → 终态按 `Failed/IO` 上报 | warn |
| `process_output_error` | 读子进程 pipe 失败 → 该流停止读取，视为 EOF | warn |
| `execution_timeout` / `execution_cleanup_timeout` | 超时杀进程 / 清理宽限到期 | warn |
| `execution_cancelled` | 取消杀进程 | info |
| `stream_send_error` | 执行事件转发时连接已关 | warn |
| `panic` / `task_join_error` | 后台任务（文件操作、事件转发）join 失败，按 `is_panic()` 区分——**panic 被隔离在任务边界，不感染 serve 主循环** | warn / error |
| `dns_resolution_error` 等四类 | 连接失败归因（§2.3） | warn |

Windows 侧 Job Object 创建 / 分配失败也不致命：降级为只 `TerminateProcess` 直接子进程并 warn（杀不到孙进程，但好于什么都杀不掉）。

---

## 4. 卡死（Hang）防护

每一类"可能永远等下去"的场景都有对应的有界机制，多数有专项测试锚定：

| # | 卡死场景 | 防护机制 | 验证测试 |
|---|---|---|---|
| 1 | 子进程本身不退出 | `sleep_until(deadline)` 与 `wait()` 同场 select，超时即杀进程树，终态 `TimedOut`；`timeout_ms=0` 落到配置默认值 | `timeout_ends_timed_out_without_waiting_the_full_duration` |
| 2 | shell 退出但**孙进程握着 stdout/stderr**，drain EOF 永远不来 | 进程一退出就 `killer.kill()` 清掉整个进程组，再给 `CLEANUP_GRACE = 1 s` 宽限 drain；到期强制收尾，附 `TOO_LARGE "output truncated at execution cleanup deadline"` | `shell_exit_cleans_inherited_pipes_and_preserves_output` |
| 3 | gRPC 消费端停滞 → 有界通道塞满 → 执行任务卡在 `send` 上 | 输出发送走 `event_tx.reserve()` permit，且只是 select 的**一个分支**——超时 / 取消分支照常触发，杀进程、释放并发槽不受背压影响 | `stalled_event_consumer_does_not_delay_timeout_or_hold_running_slot`、`output_backpressure_does_not_block_timeout_or_cancel` |
| 4 | 消费端断连 / 事件流被 drop，执行却继续跑 | `event_tx.closed()` 作为独立 select 分支，等价取消：杀进程树、释放容量 | `dropping_event_stream_cancels_process_and_releases_capacity` |
| 5 | reader 任务守着一条永远无数据也无 EOF 的 pipe | reader select 中含 `tx.closed()` 分支，执行侧 drop 接收端即退出 | `closing_consumer_stops_reader_even_when_pipe_has_no_data_or_eof` |
| 6 | 进程自己关掉 stdout/stderr 后长眠（无输出可等） | 超时 / 取消不依赖输出流状态，`output_done` 与否都照常触发 | `closing_output_does_not_disable_timeout_or_cancellation` |
| 7 | 失控命令刷屏（如 `find /`）拖垮整条链路 | 10 MB 转发上限：停止转发但继续 drain（不反压死子进程），进程自然跑完 | 常量 `MAX_OUTPUT_BYTES` |
| 8 | TCP 建连黑洞 | `connect_timeout(10 s)` | — |
| 9 | 半开连接 / 代理静默丢流 | h2 keepalive PING 60 s + 超时 20 s + `keep_alive_while_idle`，TCP keepalive 60 s；PING 周期故意**慢于应用心跳**，避免瞬时背压被误判成流损坏 | — |
| 10 | 服务端下发 0 心跳间隔导致空转打满 | `interval_ms.max(100)` 钳制 | — |
| 11 | 服务器长期不可达，重连风暴 | 指数退避封顶 10 min；1 000 次后进程退出交外部守护 | `reconnect_delay_grows_from_one_second_to_ten_minutes` |
| 12 | 取消信号与注册竞态（missed wakeup 导致永远等不到取消） | `Cancel::cancelled()` 先注册 `Notified` 再复查 `AtomicBool` | — |
| 13 | 排队中的执行无人取消、永远占 admission 槽 | `wait_for_running_slot` 与 cancel select；断连 / Shutdown `cancel_all()` 覆盖排队态（不 spawn 直接终态） | `queue_full_returns_busy_immediately`（容量语义） |
| 14 | 同步文件 IO（大目录 list、grep 全树扫描）阻塞异步 runtime | 一律 `spawn_blocking`；并发槽 4 满员立即 `BUSY`，不排无界队 | — |
| 15 | 会话结束后文件任务仍挂着 | 退出 serve 循环时 `abort_all()` 并逐个 `join_next()` 收尸 | — |
| 16 | 大 stdin 写入阻塞执行主流程（进程不读 stdin） | stdin 写入是独立 spawn 的任务，失败仅 warn | — |
| 17 | 超时 / 取消杀完进程后，`Child` 未被 reap | `kill_on_drop(true)` + 主循环退出前显式 `drop(process)` 兜底 | — |
| 18 | 巨型单行文件（minified）读爆内存 | `read_bounded_line` 只保留上限内字节，超出部分消费但丢弃，置 `line_truncated` | `bounds_a_single_enormous_line`、grep 的 `marks_search_incomplete_when_a_line_exceeds_the_bound` |
| 19 | 优雅停机时主流程卡在 connect / sleep 上 | shutdown watch 在连接与退避 sleep 两处都参与 select，SIGTERM / Ctrl-C 即刻 `cancel_all()` 返回 | — |

设计上的总原则：**每一个 `await` 都有对手分支**——超时、取消、通道关闭三者至少其一能与任何可能挂起的等待竞速；任何"等待外部"的循环（重连、drain、reader、serve）都有终止条件或上限。

---

## 5. 测试与验收映射

testing.md §2/§3 对本 crate 的四组要求与测试对应：

| 验收项 | 测试 |
|---|---|
| 并发上限与队列满 | `queue_full_returns_busy_immediately` |
| 超时 | `timeout_ends_timed_out_without_waiting_the_full_duration` + 背压 / 关闭输出场景 3、6 |
| cancel 杀进程组（进程**真的死了**） | `cancel_actually_kills_the_process`（轮询 `process_alive` 至多 5 s） |
| 路径越界（含符号链接） | `workspace::tests`：相对 / 绝对逃逸、新文件符号链接逃逸、合法链接目录放行；`file::tests`：删链接不删目标、rename 不覆盖不跟随 |

集成测试（`tests/integration/`）不用 mock：由 `@nova/runner-sdk` 在 loopback 随机端口起真实服务端，spawn 本 crate 编译出的真实二进制出站连接。

---

## 6. 已知边界与 Phase 1 取舍

- **文档不一致（待修）**：`config.rs` 中 `default_timeout_ms` 代码默认值为 **12 000 ms**，而 `crates/runner/README.md` 与 `docs/runner.md` §9 写的是 **120 000**。近期提交（"优化 tool 执行超时"）改了代码未同步文档，需确认哪个是意图值。
- **Registry 无淘汰**：`execution_id` 幂等表随 Runner 生命周期只增不减——本地开发进程可接受的简单性 / 内存取舍；长期运行的托管 Runner 需要淘汰策略。
- **ResourceLimits / Sandbox 未实现**：请求携带非零资源限制或沙箱要求直接 `UNSUPPORTED`。
- **信号死亡不建模**：被 Runner 之外的信号杀死的进程按 `Completed / exit_code = -1` 上报，没有独立状态。
- **Windows 降级杀进程**：Job Object 建不起来时只能杀直接子进程，孙进程会漏（有 warn 日志）。
- **WriteFile 在 serve 循环内联处理**（不占文件并发槽、不 spawn）：单个 chunk 写入是短 async 操作，但理论上存在对后续 envelope 的队头阻塞。
- **grep 静默跳过打不开的文件**：权限问题不体现在结果里，只有 `truncated / incomplete` 标志。
- **`.nova-tmp` 无清理**：`temp_dir` 用 `keep()` 交出所有权后，Runner 不再回收。
