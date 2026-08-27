# 基于 DeepSeek Harness 的 Greenfield Remote Runner 架构方案

> 状态：分析完成，可作为 PoC 与重新开发的架构输入  
> 前提：不兼容、不重构 Nova 当前 `agent-core`，按重新开发评估  
> 目标：复用 DeepSeek Harness（下文简称 DSH）Agent 核心，自研产品 Server，所有工作区能力只在 Remote Runner 执行  
> 约束：DSH 上游目录只读，无长期补丁、无源码 fork；二开只存在于树外适配层

## 1. 结论

该方案可行，而且 Greenfield 场景比“替换现有 `agent-core`”更适合轻量二开。因为不需要维持 Nova 现有 Agent API、Entry / Record 数据模型和内部状态机，可以直接接受 DSH 的 Agent、Session、Tool、Prompt、Compaction 与 Subagent 语义，只在产品边界做适配。

推荐方案不是运行 `dsh-headless`、复用 DSH CLI，或修改 `dsh-base`，而是：

1. 在自研 Server 进程内，把 DSH 当作公开的 Cordis Runtime 插件使用；
2. 自建一个薄的 `dsh-runtime` 组合包，显式装配所需 DSH 核心插件；
3. 树外实现 PostgreSQL Session Persistence、Remote FileSystem、Remote Shell、Server Event Bridge 和交互桥；
4. Remote Runner 继续通过出站双向 gRPC 连接 Server，DSH 不理解 gRPC、用户、项目和浏览器协议；
5. 每个 **Runner 连接代际**拥有独立 Harness Runtime Shard，Shard 内可运行多个 Agent；
6. 上游 DSH 作为精确版本依赖或只读 Git 子模块存在，业务实现不得写入其目录。

第一版只实现远程文件系统和前台 Shell。后台任务、PTY、Terminal、LSP、ACP 和远程 Skill 分阶段增加，以最快形成“浏览器 → Server → DSH Agent → Remote Runner”闭环。

| 判断 | 结论 |
|---|---|
| DSH 没有产品 Server，能否嵌入自研 Server | 能。`ctx.agents` 是公开驱动面，DSH JSON-RPC Server 与 ACP 已证明传输可树外挂接 |
| 是否需要修改 Agent Loop | 不需要。输入、取消、事件、工具、FS、Shell、LLM、持久化均有公开 seam |
| Server 能否完全不访问本地 workspace | 能，但生产组合不得装载 DSH 本地 FS、Shell、Subprocess 和本地 Skill Provider |
| 能否直接复用现有 Runner | 连接模型可以；文件协议需增加版本与原子写，后台进程和 PTY 后续扩展 |
| DSH 更新后能否直接 `git pull` | 能保证上游目录可干净更新，不能保证 API 永不变化；仍须编译与契约测试 |
| 是否直接依赖 `dsh-agent-spine-demo` | PoC 可以；生产应自行写小型显式组合，避免示例包隐式带入本地能力 |

DSH 负责“Agent 如何思考和调用工具”；Server 负责“谁可以运行、会话属于谁、事件如何交付”；Runner 负责“文件与命令实际如何执行”。

```text
Browser / API Client
        │ HTTP + SSE / WebSocket
        ▼
Own Product Server
  ├─ Auth / Project / Conversation
  ├─ AgentRuntimeRegistry
  ├─ Session Projection / Interaction Broker
  ├─ PostgreSQL DSH Persistence Provider
  └─ RunnerRegistry + gRPC Gateway
        │                         │
        │ in-process public APIs │ outbound bidirectional gRPC
        ▼                         ▼
DeepSeek Harness Runtime      Remote Runner
  ├─ Agent / Loop               ├─ workspace boundary
  ├─ Session / Prompt           ├─ file operations
  ├─ Tools / Compaction         ├─ process execution
  ├─ Subagent / Goal            └─ cancellation / limits
  └─ Remote FS + Shell adapters
```

## 2. 目标、非目标与不变量

### 2.1 目标

- DSH 作为无 UI、无产品 Server 的 Agent Runtime Core；
- 自研 Server 负责认证、项目、会话、在线 Runtime、REST/SSE/WebSocket 与数据库；
- workspace 文件、命令和以后增加的终端能力只通过 Remote Runner；
- Server 不提供本地 workspace fallback；
- 二开表现为树外 Cordis 插件、Provider、Projection、Bridge 和组合包；
- Server 与 Runner 协议由己方控制，不要求 DSH 上游接受 Remote Runner 设计；
- 可在没有产品 Server 时启动测试 Runtime。

### 2.2 非目标

- 不保留当前 `@nova/agent-core` API、Entry / Record 或 ToolContext；
- 不复用 DSH Web UI、CLI Host 或产品壳；
- 不把 Nova 包写入 `deepseek-harness-master/packages`；
- 不通过 `patch-package` 或修改 DSH Loop 集成；
- 第一版不承诺后台进程、PTY、Terminal、LSP、ACP 和完整远程 Skill。

### 2.3 不变量

1. `AgentRuntimeRegistry` 独占 AgentHandle 的创建、恢复、取消、驱逐和释放。
2. `RunnerRegistry` 独占连接代际、请求关联、断线和取消。
3. 一个 Runtime Shard 的 `ctx.fs` 与 `ctx.shell` 永远指向同一 Runner 连接代际。
4. 同一 DSH Session 在所有 Server 副本中最多一个活动写者。
5. DSH Session Event Log 是 Agent 历史事实，产品表是可重建查询投影。
6. Runner 不可用时返回基础设施错误，绝不静默落到 Server 本机。
7. CI 检查 DSH 工作树干净，所有扩展只依赖公开 package export。

## 3. DSH 的复用与装配方式

### 3.1 直接复用

| 能力 | DSH owner | 自研部分 |
|---|---|---|
| Agent 生命周期与输入队列 | `dsh-agent`：`followup`、`steer`、`inject`、`cancel`、`whenIdle` | Server 管理 Handle 和准入 |
| Agent Loop | `dsh-agent-loop` | 不修改 |
| Session Event Log | `dsh-session` | PostgreSQL Provider 与产品投影 |
| Tool 注册与执行 | `dsh-tools` 及工具插件 | Remote FS / Shell、审批桥 |
| System Prompt | `dsh-system-prompt`、Agent Instructions | persona、按 Runner 平台选择工具 |
| LLM 与重试 | `dsh-llm`、`dsh-llm-retry` | 官方 Provider 或树外网关 Adapter |
| Compaction / Subagent / Goal | DSH 对应插件 | 配置，后两项延后启用 |
| Scope / Preset | `dsh-scope`、`dsh-agent-presets` | Agent 能力套餐，不负责 Runner 路由 |
| Approval / Questions | DSH 事件和回答 seam | Server Interaction Broker |

### 3.2 不直接使用 `dsh-headless` / `dsh-base`

`dsh-headless` 是一次性任务入口，不是多租户可恢复 Server。`dsh-base` 会装配本地 Sandbox、FS、Shell 等能力，容易破坏“只经 Remote Runner”的约束。

- `dsh-headless` 只作生命周期参考；
- `dsh-base` 只作依赖闭包参考；
- `dsh-agent-spine-demo` 用于 PoC；
- 生产由 `@nova/dsh-runtime` 用公开插件显式组装。

这个 Composition Root 只是明确选择插件，不复制 DSH 核心代码，也避免上游 Bundle 更新时意外带入本地执行器。

### 3.3 第一版最小组合

```text
Cordis Context
├─ timer / dsh-llm / dsh-session
├─ our PostgreSQL session persistence
├─ dsh-system-prompt / dsh-tools / dsh-agent / dsh-llm-retry
├─ our RemoteFileSystem + dsh-fs-observation-policy + dsh-tool-fs
├─ our RemoteShellExecutor + dsh-tool-bash OR dsh-tool-pwsh
├─ optional dsh-agent-instructions
└─ dsh-agent-loop
```

生产不得装载 DSH 本地 FS、Shell、Subprocess、Sandbox、本地 Skill FileSystem 或本地持久化作为事实源。

### 3.4 Profile、Bundle 与 Preset

DSH Profile 可通过 `$DSH_HOME/profiles/<name>/package.json` 和 `cordis.patch.yml` 装载树外包，证明无需 fork 即可扩展。但产品 Server 推荐代码式组合：类型、生命周期、配置审计更清晰，也不依赖用户主目录和整段配置替换。Profile 只用于本地调试入口。

Preset 适合隔离工具、提示词和投影，通过 `AgentRegistry.create({ setup(agentCtx) })` 在 Agent 发布前挂载。但它不应选择 Runner：`ctx.fs` / `ctx.shell` 是 Runtime Service，FS API 没有 Agent 参数；同一根 Context 临时切换 Runner 容易串线。本方案由 Shard 固定执行世界，Preset 只决定 Agent 能看到什么。

## 4. 推荐总体架构

### 4.1 每个 Runner 连接代际一个 Runtime Shard

```text
Runner logical id: runner-123, generation: 42
        │
        ▼
HarnessRuntimeShard
  ├─ one Cordis root Context
  ├─ RemoteFileSystem bound to lease 42
  ├─ RemoteShellExecutor bound to lease 42
  ├─ DSH core plugin graph
  ├─ Agent A
  ├─ Agent B
  └─ Agent C
```

同一 Runner 的多个 Agent 共享 Provider，但各自 Session、scope、工具调用和 cwd 独立。不同 Runner或重连的新代际使用不同 Shard，绝不在旧 Context 上替换连接引用。这样同步的 `processPath()` / `contains()` 也始终对应一个文件命名空间，旧 `FsTarget` 和进程 Handle 不会被新连接误用。

| 事件 | 行为 |
|---|---|
| Runner 注册 | 创建 generation、RunnerLease 和 Runtime Shard |
| 首次访问 Session | 获取分布式 lease，在对应 Shard create / resume Agent |
| 用户输入 | 先订阅事件，再 `agent.followup()`，返回 `messageId` |
| 取消 | `agent.cancel()`，AbortSignal 传给 Runner request |
| Agent 长时间 idle | flush、dispose Handle、释放 Session lease |
| Runner 断线 | generation 失效，取消执行并 dispose Shard 内 Agent；持久化负责恢复 |
| Runner 重连 | 新 generation、新 Shard；Session 从日志恢复，不复用旧对象 |
| Server 关闭 | 停止准入，取消、等待、flush、dispose Agent 和 Shard |

### 4.2 Server 模块

```text
apps/agent-server
├─ HttpApi / ConversationService
├─ AgentRuntimeRegistry / SessionLeaseManager
├─ SessionEventProjector / InteractionBroker
├─ RunnerRegistry / RuntimeComposition

packages/dsh-integration
├─ runtime
├─ persistence-pg
├─ runner-fs
├─ runner-shell
├─ server-bridge
└─ testkit
```

名字可调整，职责不可混合。

### 4.3 无 Server 运行

提供内部 Testkit，调用与 Server 相同的 Runtime factory：

```ts
const runtime = await createHarnessRuntime({
  runner: fakeRunnerLease,
  persistence: memoryOrTempSqlite,
  model: replayOrTestAdapter,
})
const agent = await runtime.createAgent({ cwd, model, provider })
await agent.followup({ contentBlocks })
await agent.whenIdle()
await runtime.dispose()
```

它用于 DSH 升级契约、Adapter 测试和录制模型回归，不另建一套 Runtime。

## 5. Remote Runner Capability

### 5.1 第一版 Provider

`RemoteFileSystem` 实现 DSH `FileSystem`：

- `resolve()` → 稳定 `FsTarget`；
- 同步 `processPath()` / `fileUrl()` / `contains()`；
- `stat()` / `lstat()`；
- `readText()` / `streamText()` / 有界 `readBytes()`；
- `listDir()`；
- 带版本意图的原子 `writeText()`；
- 带版本校验的原子 `editText()`；
- 类型化 `FsError`。

继续复用 `dsh-tool-fs` 与 `dsh-fs-observation-policy`，不重写文件工具。

`RemoteShellExecutor` 实现高层 `ShellExecutor`：`resolve()` 限制 cwd、timeout、输出、env 和 policy；`run()` 映射前台执行；`start()` 第二阶段实现。非零退出、超时和取消返回 `ShellRunResult`，只有连接失败等基础设施问题 reject。

完整 `SubprocessRuntime` 暴露 Node stream、进程树和 PTY，远程映射涉及背压、游标、stdin 半关闭、process-group kill、resize 和断线竞态，不是第一版必要条件。

### 5.2 现有 Runner 的缺口

| DSH 需求 | 现有能力 | 建议 |
|---|---|---|
| 出站双向连接、执行、取消 | 已有 | 保留并映射 `ShellExecutor.run()` |
| stat/list/read/write | 基础已有 | 扩展为 DSH 语义 |
| 稳定 `FsTarget` | 无明确协议 | 增加 ResolvePath，返回 opaque id 与 canonical process path |
| `lstat` | 语义不完整 | 明确 follow / no-follow |
| revision token | 无 | stat/read/write 都返回不透明 revision |
| compare-and-write / atomic edit | 无 | 在 Runner 内版本校验与写入同一临界区完成 |
| 后台进程 Handle | 不完整 | 第二阶段 start/read/kill + offset |
| PTY | 无 | 第三阶段实现 |
| Sandbox | 字段预留 | 未实际 enforce 前不得宣称 sandboxed |

建议文件语义：

```text
ResolvePath(path, cwd)
  -> target_id, target_key, display_path, process_path, file_url, generation
Stat(target_id, follow_symlink) -> kind, size, mtime, revision
ReadText(target_id, max_bytes) -> text, revision
ListDir(target_id) -> children
WriteText(target_id, content, intent, expected_revision?)
  -> operation, revision, before?, after
EditText(target_id, old_text, new_text, expected_revision)
  -> revision, before, after
```

规则：target 必须绑定 Runner id、generation 和 workspace；旧 generation 返回 stale-target；`process_path` 是远程路径；resolve 缓存元数据供同步方法使用；revision 不透明；原子校验在 Runner 内完成；Runner 始终再次验证 workspace containment 和 symlink 边界。

Shell 第一阶段复用 `Execute → Started/Output/Finished` 与 `Cancel`。第二阶段增加 `StartProcess / ReadProcess(offset) / KillProcess`。后台 Handle 属于发起它的 generation；断线后 outcome unknown，不自动在新 Runner 重放副作用命令。

### 5.3 平台、Sandbox 与 Skill

- POSIX Runner 装 `dsh-tool-bash`，Windows Runner 装 `dsh-tool-pwsh`；
- Runner 注册报告平台、默认 shell、能力与协议版本；
- Shard 的 shell 类型在生命周期内冻结；
- Runner 才是安全边界；审批不是沙箱；
- Runner 未实现 sandbox 时 Provider 不返回伪造的 sandbox facts；
- Agent Instructions 启用前须确认只经 `ctx.fs` 读取；
- 生产不装 DSH 本地 Skill FileSystem。第一版关闭 Skill 或仅使用部署内置只读 Skill，后续实现 Remote Skill Provider。

## 6. 自研 Server

### 6.1 输入与 Agent 生命周期

采用异步语义：Client 先订阅 SSE，再 POST message；Server ensure Agent、先建立 DSH 订阅、再 `followup()`，返回 `202 + messageId`。`messageId` 只表示 inbox 准入，不等于唯一 assistant answer。自动化接口若需要最终结果，应单独定义 enqueue → Agent idle 活动区间。

`AgentRuntimeRegistry` 应：

- 对 ensure 做单航班，禁止并发 create / resume；
- 创建或恢复前取得跨副本 Session lease；
- 在 `setup(agentCtx)` 挂载 Preset，失败则整体回滚；
- 独占 AgentHandle，不允许 Controller 缓存第二 owner；
- idle 驱逐前 flush，再 dispose；
- Runner generation 失效时准确清理所属 Handle；
- shutdown 先停准入，再 cancel、等待、flush、dispose。

### 6.2 PostgreSQL Session Persistence

实现 DSH 公共 `SessionPersistence`，优先复用公开 `PersistenceCoordinator`，只实现 PostgreSQL `PersistenceBackend` 原语，从而继承批写、严格顺序、crash repair、inspect / prepare、flush 和 dispose 语义。

```text
dsh_session
  session_id PK, format_version, header_jsonb,
  next_seq, revision, created_at, updated_at

dsh_session_event
  session_id FK, seq, event_type, event_jsonb, created_at
  PK(session_id, seq)
```

| Backend hook | PostgreSQL 行为 |
|---|---|
| `loadStored` | 同一事务读取 header 与连续 event prefix，返回 revision |
| `readStoredRevision` | 只读 revision |
| `loadStoredFrom` | 按 session + seq 索引读取后缀 |
| `appendBatch` | 锁 session 行，验证首 seq，批插入并递增 revision |
| `commitRepair` | 清理 torn tail 并追加 synthetic closers |
| `list` | 读取 header；注意 DSH 接口无分页 |

产品 Conversation 表不能代替 DSH Event Log，只存 owner、标题、Runner 绑定和查询投影。

### 6.3 单写者、Projection 与交互

DSH revision 不等于跨进程排他。多 Server 副本必须在 create / resume 前取得 PostgreSQL advisory lock，或使用带 expiry 和 fencing token 的 lease 表；owner 丢失 DB lease 时立即取消和 dispose Agent。

Server 监听 `session/event`，投影消息、状态、工具卡和 usage，并发布 SSE。浏览器协议使用自有稳定类型，不直接暴露 DSH 联合类型；保留 DSH `seq` 作为 watermark。重连先补持久投影再接在线 Event Hub；原始模型增量可只在线传输，已提交事件才是恢复事实。

Interaction Broker 把 DSH approval / question 转为持久 interaction 和 SSE，REST answer 完成等待 Promise。它必须保证一次回答、在 cancel/dispose/断线时结算等待者，并明确 Server 重启时恢复还是 unavailable。第一版接受 DSH 一次性权限语义，不私自增加 allow-always。

### 6.4 LLM 与协议参考

可直接用 DSH Provider，或树外实现 Model Gateway `LlmAdapter`。Provider/model/输出上限和能力快照在 Session 创建时记录，恢复时重新解析；Loop 内不加入网关判断。

`dsh-sdk-jsonrpc-server` 与 `dsh-acp` 只作桥接参考，不作为产品主协议：前者缺逐 Session close/prompt cancel，ACP 面向自动化且无完整 UI 投影和恢复。应复用它们“通过 `ctx.agents` 驱动、订阅事件、明确 Handle owner、释放时完整停稳”的模式。

## 7. 零上游修改与升级

### 7.1 依赖方式

生产精确锁定同一版本的 DSH 已发布包并提交 lockfile，不用 `^` 漂移预览版。完整上游仓库可放在 `third_party/deepseek-harness/` 作为只读 Git 子模块或 sibling checkout，用于阅读源码、运行上游测试和验证目标 commit，不承载 Nova 代码。

如果必须跟踪 Git 主干：

1. 更新独立上游 checkout；
2. 在上游自己的 pnpm / workspace 中构建；
3. pack 公开包或发布到受控本地 registry；
4. Nova 只消费构建产物；
5. 不把两个 monorepo 合并为一个 pnpm workspace。

严格禁止：修改 DSH `packages/**`、导入 `@deepseek-ai/*/src/*`、长期 patch、依赖 fixture、浮动 latest 自动生产、把 DSH 原始事件直接作为外部 API。

合理自研范围：

| 包 | 内容 | 复杂度 |
|---|---|---|
| `dsh-runtime` | 显式组合与配置 | 低 |
| `dsh-runner-fs` | DSH FS ↔ Runner RPC | 中 |
| `dsh-runner-shell` | DSH Shell ↔ Runner execution | 中 |
| `dsh-persistence-pg` | PersistenceBackend ↔ PostgreSQL | 中高 |
| `dsh-server-bridge` | lifecycle / event / interaction | 中 |
| Runner 协议扩展 | revision、后台进程、以后 PTY | 分阶段中高 |

这些代码都集中在边界包，DSH 更新时不会扩散到整个产品。

### 7.2 更新流程

零修改解决“可以干净 pull”，契约测试解决“pull 后仍可用”。流程必须是：

```text
update DSH commit/version → build/install → public API compile
→ provider conformance → recorded-model scenarios
→ real Runner canary → session backward-read/recovery
→ manual release decision
```

记录 DSH package 版本或 SHA、Session format、Runner protocol、本集成层版本和验证过的 Node/pnpm/TypeScript 组合。

升级 CI 至少检查：上游工作树干净、无源码子路径 import、Adapter 编译；FS 的路径/版本/原子写；Shell 的退出/超时/取消/截断/断线；创建/工具/多轮/取消/恢复/压缩场景；旧版本 Session 被候选版本读取；Runner 断开无本地 fallback；生产组合无本地执行 Provider。

## 8. 实施路线

### Phase 0：上游契约 Spike（3–5 天）

- 用公开包创建最小 Context；
- 假 LLM 完成 create、followup、event、cancel、dispose；
- 完成共享 `createHarnessRuntime()` Testkit；
- 冻结 DSH 版本 / SHA。

验收：无 Server/CLI 完成一轮固定模型对话；无内部 import；上游零修改；dispose 后无悬挂资源。

### Phase 1：Remote FS + 前台 Shell（1–2 周）

- 扩展 Runner Resolve、revision、guarded write/edit；
- 实现 Remote FS 与 Shell run；
- 按平台装 bash/pwsh；
- 先用 SQLite/JSONL/内存 persistence 端到端。

验收：远程 list/read/edit/create；并发修改不静默覆盖；退出、超时、取消事实正确；断线为基础设施错误；Server 无本地工作区旁路。

### Phase 2：Server + PostgreSQL（2–3 周）

- RunnerRegistry / Runtime Shard / AgentRuntimeRegistry；
- Session lease、PostgreSQL Backend；
- HTTP、SSE、Interaction Broker；
- idle eviction 与 shutdown quiescence。

验收：多用户隔离；同 Session 无双恢复；Server 重启可恢复；SSE watermark 重放；中断工具按 DSH 规则闭合；Runner 重连不复用旧对象。

### Phase 3：后台进程与上下文（1–2 周）

- Runner start/read/kill 和 `ShellExecutor.start()`；
- background job UI；
- 验证 Remote Agent Instructions；
- 按需实现 Remote Skill Provider。

### Phase 4：PTY / Terminal / LSP

只有产品明确需要交互终端或语言服务器时再实现 Remote Subprocess / PTY，不作为替换 Agent Core 的前置条件。

## 9. 风险与 Go / No-Go

| 风险 | 控制 |
|---|---|
| DSH 预览版破坏 API | 精确锁版本、公开出口、升级契约 CI |
| Session 格式变化 | 保留原始日志，升级前 backward-read canary，必要时保留旧 Runtime 只读 |
| FS 版本语义不足 | Runner 内 revision + compare-and-write |
| 断线命令结果未知 | 不自动重放副作用，恢复后验证 |
| Context 路由多个 Runner | 按 generation 创建独立 Shard |
| 多 Server 双写 | 分布式 lease / fencing |
| 动态插件绕过 Runner | 生产代码式组合、禁用户 Profile、启动审计 Service |
| PG Provider 损坏日志 | 复用 PersistenceCoordinator，做 crash/torn-tail/并发测试 |

进入正式开发前须满足：

- [ ] 公开 package root 足以组装 Runtime；
- [ ] Remote FS 通过版本写与路径安全测试；
- [ ] Remote Shell 正确处理取消、超时、断线；
- [ ] PostgreSQL Backend 通过 recovery / prepare / flush 测试；
- [ ] Shard 在断线时可完全 dispose；
- [ ] 多副本 lease 不会双写；
- [ ] 候选 DSH 能读取必要的基线 Session；
- [ ] 生产组合没有本地 workspace Provider；
- [ ] 团队接受 DSH Session / Tool / Approval 语义，不再维护 Nova 旧抽象。

若前四项任一失败，说明公开 seam 不足。此时应向 DSH 上游贡献通用扩展点；上游合并前不要以长期私有 patch 进入生产。

## 10. 依赖方向与最终推荐

```text
packages/dsh-runtime → DSH public packages
packages/dsh-runner-provider → DSH fs/shell definitions + runner-sdk
packages/dsh-persistence-pg → DSH session-persistence + DB client
packages/dsh-server-bridge → DSH agent/session + internal protocol
apps/agent-server → above integration packages + product services
crates/runner → runner protocol only; never DSH/Agent types
```

禁止 Provider 依赖 Web Controller、Runner 依赖 DSH 类型、产品协议导出 DSH 内部类型、Persistence 管理 Conversation、Projection 拥有 Agent lifecycle。

最终推荐组合是：

> **DSH public core packages + 自有最小 Runtime Composition + PostgreSQL Persistence Provider + Remote FS / Shell Provider + 自有 HTTP/SSE Server + 现有 Runner 出站连接模型。**

上游采用双轨：生产精确锁定已发布 packages，完整 Git 仓库作为只读参考和候选验证；若追 main，则在独立 workspace 构建并 pack，Nova 只消费产物。

第一阶段先证明：Agent 只经 Remote Runner 完成真实任务；Session 可在 PostgreSQL 安全追加和恢复；Runner generation 对应唯一 Shard；DSH 更新的破坏只落在少量 Adapter 且能被 CI 发现。四项成立后，该方案能避免维护第二套 Agent Core，同时保持上游可持续升级。

## 11. 本地参考资料

DeepSeek Harness：

- `deepseek-harness-master/README.md`
- `deepseek-harness-master/docs/capability-seams.zh.md`
- `deepseek-harness-master/docs/cookbook/extension-cookbook.zh.md`
- `deepseek-harness-master/docs/subsystems/filesystem.zh.md`
- `deepseek-harness-master/docs/subsystems/subprocess.zh.md`
- `deepseek-harness-master/docs/subsystems/shell.zh.md`
- `deepseek-harness-master/packages/examples/agent-spine-demo/src/index.ts`
- `deepseek-harness-master/packages/bundle/headless/README.zh.md`
- `deepseek-harness-master/packages/bundle/base/README.zh.md`
- `deepseek-harness-master/packages/preset/agent-presets/README.zh.md`
- `deepseek-harness-master/packages/fs/fs/README.zh.md`
- `deepseek-harness-master/packages/subprocess/subprocess/README.zh.md`
- `deepseek-harness-master/packages/shell/shell/README.zh.md`
- `deepseek-harness-master/packages/session/session-persistence/README.zh.md`
- `deepseek-harness-master/packages/sdk/server/README.zh.md`
- `deepseek-harness-master/packages/acp/acp/README.zh.md`

Nova 参考：`docs/runner.md`、`docs/runner-sdk.md`、`docs/proto.md`、`docs/agent-server.md`、`docs/deepseek-harness-agent-core-feasibility.md`。
