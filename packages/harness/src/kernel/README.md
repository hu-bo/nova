# Kernel

Kernel 是运行时的装配与生命周期边界。它只负责把宿主选择的插件组装成受控能力图，不负责 Agent Prompt、模型协议、工具业务逻辑或 Task Flow 规则。

## 模块职责

- `graph.ts`：校验 Plugin Manifest，解析 capability 依赖、版本、作用域和 before/after 关系，生成稳定安装顺序，并生成安全的插件 inspection 摘要。
- `registry.ts`：维护当前作用域的 singleton capability 和 collection contribution。父作用域能力可以被子作用域读取，但能力不会被子作用域反向覆盖。
- `scope.ts`：拥有 `AbortController`、子作用域、cleanup 栈和逆序释放逻辑；取消与释放都由受管 Scope 负责。
- `context.ts`：提供宿主侧 `Context`，完成插件注册、批量安装、setup 回滚、ready 冻结、能力访问和子作用域创建。
- `admission.ts`：提供原子资源准入、等待、取消、幂等释放和资源快照。
- `operation.ts`：管理 Session 的 send、compact、resume、取消、超时、事件通知和 Run Context。
- `kernel.ts`：创建 Agent Kernel，提供会话去重、会话上限、统一 Agent 准入以及 Task Engine 入口。
- `install.ts`：为已有 Scope/Registry 提供受控的插件批量安装辅助函数。

## 作用域

框架使用三种作用域：

```text
kernel
  └─ session
       └─ run
```

较长生命周期的插件不能捕获较短生命周期的能力。Session 和 Run 通过父 Registry 读取上层只读能力，并可以在自己的作用域提供局部能力。插件的 setup 资源绑定到创建它的作用域，作用域销毁时自动清理。

## 插件安装流程

```text
register → validate manifest/config → compile dependency graph
         → setup in order → onReady → freeze registry
         → accept work → dispose in reverse order
```

插件必须在 Manifest 中声明 `requires`、`optional`、`provides` 和 `contributes`。setup 期间只能访问已声明能力；单例能力重复提供、版本不匹配、循环依赖和跨作用域依赖都会在安装阶段拒绝。

setup 或 ready callback 失败时，Kernel 会尝试释放已经创建的资源并返回结构化错误。安装完成后 Registry 冻结，不能在运行期热修改插件图或注册表。

```ts
import { Context, definePlugin } from "@nnova/harness";

const context = new Context("kernel");
await context.plugin(
  definePlugin({
    manifest: {
      id: "example.capability",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [],
    },
    setup(pluginContext) {
      pluginContext.onDispose(() => undefined);
    },
  }),
);
await context.ready();
await context.dispose();
```

插件收到的是受限的 `PluginContext`。宿主 `Context` 额外提供 `fork()`、`plugin()`、`ready()`、`abort()` 和 `dispose()`；插件不能导入或操作 Kernel 的私有实现。

## 准入与操作生命周期

Agent、Task、模型请求、工具执行和宿主声明的资源都通过 `AdmissionLease` 表达。Lease 获取失败会进入受控等待或返回容量错误；Lease 的 `release()` 幂等。直接 Agent 调用和 Agent Task Adapter 共用同一会话资源键，因此不会通过不同入口绕过并发限制。

每个 Run 都有独立的 AbortSignal、超时计时器、模型路由快照和事件序列。`dispose()` 会先停止接受新工作，再取消和等待活动 Session/Task，最后释放插件作用域。

## 维护约束

- Kernel 只能依赖 `contracts` 和 `shared`，不能依赖具体插件实现。
- 新能力通过 capability/contribution Contract 注入，不在 Kernel 中加入领域分支。
- 所有后台 Promise 必须由 Scope、Session、Task 或 Adapter 持有并处理 rejection。
- 资源只有在真实执行结束后才能释放；AbortSignal 只表达取消请求。
- 变更插件集合应创建新的 Kernel，当前不迁移内存 Queue、Task、Session 或 continuation。
