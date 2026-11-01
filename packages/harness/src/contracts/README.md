# Contracts

`src/contracts` 是框架跨边界共享的类型与协议层。这里定义公共输入、输出、错误、状态和能力键，不保存运行时状态，也不依赖 Kernel、具体插件、AI SDK 或宿主业务 client。

## Contract 分组

- `plugin.ts` / `runtime.ts`：Plugin Manifest、作用域、能力键、贡献键、受限 `PluginContext` 和宿主 `Context`。
- `agent.ts` / `run.ts`：Agent Kernel、Session、Run、取消、超时、挂起恢复和 usage 结果。
- `message.ts` / `model.ts`：结构化消息、模型单步请求、流 Chunk、模型路由快照和能力矩阵。
- `tool.ts`：Tool 定义、严格输入/输出边界、Tool Context、策略和统一 Runtime。
- `session.ts` / `context.ts`：Session Store 的 revision 提交、上下文构建、压缩和 Context Contribution。
- `task.ts` / `queue.ts` / `flow.ts` / `continuation.ts`：Task、Handler、Queue、Flow、等待注册、signal 和 resume 协议。
- `admission.ts`：资源声明和 Lease 生命周期。
- `event.ts`：版本化 Agent Event、Event Journal 和只读 Observer。
- `artifact.ts`：由宿主提供的受控 Artifact 写入边界。
- `capabilities.ts`：所有标准 singleton capability 和 collection contribution 的 canonical key。
- `errors.ts`：安全的 `FrameworkError` 与公共 `SafeError` 映射。

## 设计规则

### 稳定边界

公共 Contract 不暴露第三方库的内部类型。AI SDK/OpenAI 类型只存在于模型 Adapter 内部；动态工具使用受限的 JSON Schema 类型；宿主业务数据通过 `JsonValue`、ArtifactRef 或显式 client 边界传递。

### 明确状态所有者

每类状态只有一个 owner：

| 状态                        | Owner                   |
| --------------------------- | ----------------------- |
| 插件注册、作用域和能力      | Kernel / Context        |
| Agent 历史和工具执行记录    | SessionStore            |
| Task 状态、等待和 Flow 节点 | TaskStore / Task Engine |
| 队列排序索引                | TaskQueue               |
| 模型协议转换                | ModelAdapter            |
| 工具授权、执行和结果        | ToolRuntime             |
| 事件保留与重放              | EventJournal            |

Task 不直接操作 Queue，Queue 不执行 Handler；Agent Loop 不复制 Task 状态，也不绕过 Tool Runtime。

### JSON 与 Schema

跨边界的可持久化值必须是有界、无循环、无危险属性的 JSON。Schema 校验不得静默 coercion、default 或 strip：输入和输出必须保持调用方提交的语义。未知值、缺失 usage 和未知工具副作用必须用明确状态表达，不能用隐式成功或 `0` 掩盖。

### 错误与取消

接受前的验证失败抛出 `FrameworkError`。已接受的 Agent Run 或 Task 返回结构化终态。`AbortSignal` 传播取消和 deadline，但不代表不合作的底层操作已经停止；资源释放必须等待真实执行收敛。

## 能力键

`capabilities.ts` 中的 key 同时承担运行时查找和依赖声明的 canonical identity，例如：

```ts
import { modelRouter, taskHandlers, toolRuntime } from "@nnova/harness";

// Manifest 使用 capability key 声明边界；运行时由 PluginContext.resolve/collect 读取。
const modelCapability = modelRouter.id;
const handlerContribution = taskHandlers.collection;
const tools = toolRuntime.id;
console.log(modelCapability, handlerContribution, tools);
```

Singleton 使用 `resolve()` / `provide()`，集合型扩展使用 `collect()` / `contribute()`。插件必须在 Manifest 中声明相应 capability 或 contribution，未声明访问会被拒绝。

## 扩展 Contract 的准则

新增公共能力时，先确认它跨越了真实模块边界并且存在稳定语义，再增加最小类型。不要把业务字段、Provider 请求体、数据库模型或 HTTP 细节提前放入 Contract 层。新增的状态字段必须说明 owner、生命周期、nullable/optional 语义、错误行为和取消行为，并补充边界测试。
