# Nova 文档索引

## 文档分层

三层，各管一件事。**下层不重复上层已经写死的内容。**

| 层 | 文档 | 负责 | 冲突时 |
|---|---|---|---|
| 意图 | `idea.md` | 为什么这样设计、原则、反模式 | 最低优先级 |
| 结构 | `repo-layout.md` | 有哪些模块、职责边界、依赖方向、阶段范围 | 结构问题以它为准 |
| 契约 | 本目录其余文档 | API 面、字段、状态机、协议消息 | API/字段问题以它们为准 |

`CLAUDE.md` 与 `Fastify.md` 是**编码约束**，不是设计文档，对三层全部生效。

---

## 模块文档

### 执行核心（Phase 1）

| 文档 | 对应 | 一句话 |
|---|---|---|
| [agent-core.md](./agent-core.md) | `packages/agent-core` | Turn 循环、上下文、会话、Decision、队列。最厚的一个包 |
| [taskflow.md](./taskflow.md) | `packages/taskflow` | 纯调度器：依赖图 + 有界并发 + retry/timeout/cancel |
| [tools.md](./tools.md) | `packages/tools` | Tool 语义与 Phase 1 工具集；FS / OS / Shell 只经 runner-sdk 发往 Remote Runner |
| [model-adapters.md](./model-adapters.md) | `packages/model-adapters` | 抹平 provider 差异，产出统一流式事件 |

### 执行平面（Phase 1）

| 文档 | 对应 | 一句话 |
|---|---|---|
| [proto.md](./proto.md) | `proto/` | gRPC 契约，TS/Rust 共同生成源 |
| [runner.md](./runner.md) | `crates/runner` / `nova-runner` binary | Rust native Execution Plane |
| [runner-sdk.md](./runner-sdk.md) | `packages/runner-sdk` | Node.js / TypeScript ↔ Rust Runner 技术桥梁 |

### 产品链路（Phase 2）

| 文档 | 对应 | 状态 | 一句话 |
|---|---|---|---|
| [protocol.md](./protocol.md) | `packages/protocol` | 已实现 | 浏览器 ↔ agent-server 的 HTTP + SSE 契约 |
| [chat-ui.md](./chat-ui.md) | `packages/chat-ui` | 已实现 | Block 渲染组件库，纯展示 |
| [agent-server.md](./agent-server.md) | `apps/agent-server` | 待实现 | Control Plane / Composition Root |
| [agent-web-ui.md](./agent-web-ui.md) | `apps/agent-web-ui` | 待实现 | 应用外壳、SSE 订阅、状态 owner |
| [model-gateway.md](./model-gateway.md) | `apps/model-gateway(-client)` | 待实现 | Provider 网关与它的管理后台 |

### 横切

| 文档 | 一句话 |
|---|---|
| [testing.md](./testing.md) | 三层测试、集成测试装配、交付判据 |

### 专题分析

| 文档 | 一句话 |
|---|---|
| [deepseek-harness-agent-core-feasibility.md](./deepseek-harness-agent-core-feasibility.md) | DeepSeek Harness 替代 agent-core 的能力差异、方案、迁移路线与 Go/No-Go 条件 |
| [deepseek-harness-greenfield-remote-runner.md](./deepseek-harness-greenfield-remote-runner.md) | Greenfield 场景以 DSH 为核心、自研 Server、只经 Remote Runner 执行且保持上游零修改的轻量二开方案 |

### Agent 组装

| 文档 | 对应 | 一句话 |
|---|---|---|
| [harness.md](./harness.md) | `packages/harness` | 内部可信 Agent Module 的静态组合与约束校验；不是动态 Plugin Framework |
| [coding-agent.md](./coding-agent.md) | `packages/coding-agent` | Coding Prompt 与代码工具的场景能力配置；不创建第二套 Agent Runtime |

这两个包已实现并通过测试。后续变更仍须同步维护 `repo-layout.md` 的依赖图与模块职责。

---

## 阅读顺序

**第一次读**：`repo-layout.md` §2–§5 → 本文件 → `agent-core.md` → `proto.md`。
这四份读完就能理解整个系统的骨架。**要动某个模块**：先读它的模块文档的"负责 / 不负责"和"对外 API 面"两节，
再读 `repo-layout.md` §3.1 硬性禁令确认依赖方向。
**要新增模块或改依赖方向**：改 `repo-layout.md`，不要在模块文档里悄悄扩权。

---

## 两个跨模块的概念

这两件事横跨多篇文档，改动前先读定义处，不要在下游文档里另起一套：

| 概念 | 定义处 | 下游 |
|---|---|---|
| **Project / Chat 两种模式** | `agent-core.md` §1.1 | `agent-server.md` §1.1 · `runner.md` §10 · `agent-web-ui.md` §7 · `protocol.md` §3 |
| **TODO（Plan State）** | `agent-core.md` §9 | `tools.md` §3 · `agent-server.md` §7 · `chat-ui.md` §5 · `agent-web-ui.md` §5 |

模式的本质是 **`ctx` 与工具集的有无**，不是两条代码路径。
TODO 的本质是 **压缩打不掉的进度状态**，判定靠 prompt、保活靠代码。
两者的原始素材分别在 `idea.md` 与 `todo.draft.md`。

---

## 每篇模块文档的固定结构

```text
1. 定位          负责 / 不负责（从 repo-layout 复述，不扩权）
2. 对外 API 面    硬约束，超出的不许 export
3. 核心类型       字段级定义，保持精简
4. 关键机制       状态机、时序、算法
5. 边界与禁令     容易越界的地方
6. Phase 范围     第一版做什么，什么推迟
7. 相对 repo-layout 的调整（如有）  必须写理由
```

没有"未来可能需要"的章节。需要时再加。

---

## 字段原则

贯穿所有文档：

- **能推导的不存**。`status` 能从状态机推出来就不要再存一份 `isDone`
- **能合并的不拆**。四个终态用一个 `status` 枚举，不用四种消息类型
- **可选字段要有默认语义**。`timeoutMs?` 必须写明"缺省 = 用哪个默认值"
- **第一版不留预埋字段**。唯一例外：`event_id` / `sequence`（Replay 用，`proto.md` 已说明）
