# testing

> 三层测试与交付判据。
> 结构契约见 `repo-layout.md` §4.15。

---

## 1. 三层

| 层级 | 位置 | 范围 | 启 agent-server | 启 Runner |
|---|---|---|---|---|
| Unit | 各 package 的源码旁 `*.test.ts` | Loop、Compaction、Session 树、Decision、DAG、Retry、状态机、Tool | 否 | 否 |
| Integration | `packages/coding-agent/test/` | Coding Agent → **真实 Rust Runner** | **否** | 是 |
| E2E | `tests/e2e/` | web-ui → agent-server → 全链路（含登录） | 是 | 是 |

**核心能力测试不依赖 Server。** Integration 是验证核心执行闭环的主要方式。

> 测真实业务行为和边界条件，不为覆盖率测无意义的 wrapper（CLAUDE.md Rule 20）。
> 关键状态、并发、失败、取消、超时和恢复必须可验证。

---

## 2. Unit

不启动任何进程，不碰网络与磁盘。

| 包 | 必测 |
|---|---|
| `agent-core/loop` | tool batch 的并发/串行分组、**并发上限生效（20 个 call 时在途不超过 8）**、结果顺序回填、terminate 规则、max_turns |
| `agent-core/context` | cut point 合法性（**不得切开 tool_call 与 tool_result**）、压缩失败降级、截断保头尾 |
| `agent-core/session` | 树的 fork / 回溯、resume 的三种分支（未完成 tool / 未 resolve decision / 都没有） |
| `agent-core/decision` | 超时 fail-closed、abort 期间的清理、拒绝要落 Entry |
| `agent-core/queue` | 三个排空点的时机、**不在 tool 执行中途注入** |
| `agent-core/context/todo` | 阈值以下不注入、阈值以上必注入、压缩后 TodoState 不变、注入位置在最后一条 user message 之前 |
| `agent-core` 装配 | Chat 模式（无 `ctx`）+ 含 `risk !== "none"` 的工具 → 构造期抛错 |
| `taskflow` | 状态机全路径、skipped 沿依赖传播、环检测、并发上限、取消传播 |
| `tools` | 参数校验失败返回 error 而非 throw、`content`/`details` 分离、`todo_write` 的 `in_progress` 至多 1 项 |
| `model-adapters` | 事件序列完整性、**绝不 throw**、已产出内容后不重试、429 认 `Retry-After` |
| `runner-sdk` | 错误映射表逐项、增量 UTF-8 跨 chunk 解码 |
| `crates/runner` | 路径越界拒绝（**含符号链接**）、并发上限与队列满、超时、cancel 杀进程组 |

**注入 fake 的方式**：`agent-core` 的四个注入点（`agent-core.md` §2）本身就是测试接缝，
不需要额外的 mock 框架。

```ts
const agent = createAgent({
  stream:  scriptedStream([...events]),   // 预设事件序列
  ctx:     fakeToolContext({ files }),    // 纯内存 fake，不访问测试机真实 FS / Shell
  storage: memoryStorage(),
  decide:  autoDecide({ allow: ["read"] }),
})
```

`fakeToolContext` 只用于 agent-core / tools 单元测试的确定性行为验证，不是 Local Runner，也不能进入产品代码。任何验证真实文件、进程、Git 或 Shell 行为的测试都必须走 `runner-sdk → Remote Runner` 的集成链路。

---

## 3. Integration

**这一层是 Phase 1 的核心交付物。**

```text
agent-core ──► runner-sdk 真实 gRPC listener ◄──outbound gRPC── 真实 Rust Runner
   │
   ├── stream   = 真实模型 或 录制回放（§3.2）
   ├── decide   = 自动策略
   ├── storage  = 内存 / JSONL
   └── userId   = "local"
```

不启动 agent-server、不启动 web-ui、不连数据库。

### 3.1 装配

```ts
const codingHarness = createHarness({ modules: [codingAgentModule] })

// packages/coding-agent/test/test-runtime.ts
async function createTestRuntime(opts) {
  const sdk = createRunnerSdk({})            // runner-sdk 托管 gRPC 接入点
  await sdk.listen()                          // loopback 随机端口，测试可并行
  const runner = spawn("nova-runner", [
    "--server", sdk.endpoint, "--token", testToken, "--workspace", tmpDir,
  ])                                          // 真实 Rust 进程主动连入
  const session = await new Promise(resolve =>
    sdk.onSession(candidate => resolve(candidate.accept())))
  const agent  = codingHarness.createAgent({
    stream:  opts.stream,
    ctx:     toToolContext(session, { cwd: tmpDir, signal }),
    storage: memoryStorage(),
    decide:  recordingDecide(opts.policy),   // 记录每次挂起，供断言
    userId:  "local",
  })
  return { agent, tmpDir, decisions: recordingDecide.log, cleanup }
}
```

**装配代码与 `agent-server.md` §2 的 Composition Root 结构相同** ——
这是"agent-server 只是另一个入口"的可检验证明。两处若开始分叉，说明边界漏了。

SDK listener 用 loopback 随机端口，Runner 进程主动出站连入，测试可并行。

**Chat 模式的测试 runtime 更简单**：不起 Runner、不传 `ctx`，选择只贡献 `todo_write` 的静态 Module；完整 Coding 模式选择 `codingAgentModule`。两者复用同一个 Harness 组合机制，不写第二套 Agent。

### 3.2 模型

| 模式 | 用途 | 触发 |
|---|---|---|
| 录制回放 | CI 默认。稳定、免费、快 | 默认 |
| 真实模型 | 本地验证真实行为、更新录制 | `NOVA_TEST_LIVE=1` |

录制存 `packages/coding-agent/test/fixtures/*.jsonl`（就是 `ModelEvent` 序列）。
**录制回放不是 mock**：它跑的是真实的 `model-adapters` 事件流格式，
只是事件来源换成了文件。

### 3.3 必测场景

Coding 层只保留完整业务闭环，避免重复验证 `agent-core`、`runner-sdk`、`tools` 与 Rust Runner
已经就近覆盖的单元语义。

| 场景 | 断言 |
|---|---|
| 录制回放闭环 | 读代码 → 测试失败 → 反问 → TODO → 修复 → 复测通过 → 交付 |
| 真实模型复杂闭环 | 真实模型自主读取、定位多个关联 bug、修改实现、反复验证并完成 TODO |

真实模型场景由 `NOVA_TEST_LIVE=1` 显式开启；默认 CI 运行稳定的录制回放。
审批、TODO、批处理、压缩、队列与 Resume 的状态语义归 `agent-core` 源码旁测试；取消、
超时、路径隔离、输出截断与断连归 Runner / SDK 源码旁测试。集成层只证明这些边界正确接线。

---

## 4. Phase 1 交付判据

> `packages/coding-agent/test` 跑通一个真实的
> **"改代码 → 跑测试 → 失败 → 分析 → 修复 → 再跑 → 通过 → 验证"** 闭环，
> 其中至少包含一次**审批挂起**和一次**反问挂起**（用自动策略应答）。

具体做法：准备一个含已知 bug 的小项目 fixture，让 agent 修。

```text
1. agent 读代码、跑测试        → 审批挂起（bash 属 exec，需放行）
2. 测试失败，agent 分析
3. agent 问"要改哪个实现"      → 反问挂起（自动策略给预设答案）
4. agent 改代码                → 审批挂起（write）
5. 再跑测试 → 通过
6. agent 给出最终结论
```

断言：测试最终通过、`decisions.log` 含两种 kind、Record 里有完整的 run 轨迹。

fixture 的 bug 要**至少需要 3 步才能修完**，这样能顺带验证 TODO 自动建立
（`agent-core.md` §9.3 的强制阈值）：断言 `todo-updated` Record 出现过，
且最终状态全部 `completed`。

**这一条通过 = Phase 1 完成。** 不需要 server、不需要 UI。

---

## 5. E2E

只验证完整产品链路，**不重复测核心逻辑**。

```text
web-ui → agent-server → agent-core → Runner
```

| 场景 | 断言 |
|---|---|
| 登录 | Casdoor 跳转与回调，未登录访问被拦 |
| 新建 project → 新建会话 | workspace 落库，Runner 按 workspace 选中 |
| 独立 Chat | 不建 Runner 连接，无审批卡片出现 |
| 发消息 → 看到流式回复 | SSE 增量渲染 |
| TODO 面板 | 多步任务时出现，逐项由 `[ ]` 变 `[x]` |
| SSE 断线重连 | 断网 5s 后恢复，消息不重复不丢失 |
| 审批卡片 | 出现 → 点允许 → agent 继续 |
| 中断 | 点中断，运行停止 |
| 刷新页面 | 历史正确加载，TODO 面板从历史恢复，进行中的 run 继续 |

工具：Playwright。数量控制在 **10 个以内** —— E2E 慢且脆，
它证明的是"接线正确"，不是"逻辑正确"。

---

## 6. CI

```text
push / PR:
  lint + typecheck
  cargo clippy + cargo test
  unit (全部包)
  buf lint + buf breaking          # proto 兼容性
  integration (录制回放模式)

nightly:
  integration (NOVA_TEST_LIVE=1)   # 真实模型，检测 provider 变化
  e2e
```

**E2E 不进 PR 流水线**（慢且不稳），进 nightly 和 release 前。

---

## 7. 不做的事

| 不做 | 理由 |
|---|---|
| 覆盖率门禁 | 会诱导为 wrapper 写测试。看未覆盖的**分支清单**，不看百分比 |
| 快照测试 UI | Block 渲染改动频繁，快照会变成"每次都更新"的仪式 |
| mock `crates/runner` | Integration 的价值就在于用真 Runner。要 mock 就退回 Unit 层 |
| 性能基准 | 还没有性能目标。有了再加 |
