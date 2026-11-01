# @nova/coding-harness

将 `@nnova/harness`、`@nova/tools` 和宿主提供的 Runner 装配成一个可扩展的 Agent 会话。默认保留 64 步、64 次工具调用、15 分钟运行期限、4 个并行读取、1 个并行写入和 100,000 字节工具结果上限。

## 使用

```ts
import { createCodingHarness } from "@nova/coding-harness";

const agent = await createCodingHarness({
  session: runnerSession, // 由宿主连接并校验归属，Harness 不创建或关闭 Runner
  workspaceId: "project",
  cwd: ".",
  model: { baseURL, apiKey, model: modelName },
  namespace: userId,
  identity: { userId },
  instructions: projectInstructions,
  onEvent: publishChatEvent,
});

try {
  const result = await agent.run("重构服务并运行相关测试", { signal });
  // result 保留终态、工具调用标识、确定/未知结果和模型用量。
} finally {
  await agent.close();
}
```

不传 `session` 和 `workspaceId` 时，自动使用 `chatProfile`，不注册远程文件或命令工具。可通过 `tools` 添加搜索、网页读取等宿主工具。只提供一部分远程配置会报错，不会降级为普通聊天。

`run` 接受字符串或 Harness `AgentMessage`，支持附件、显式 `runId`、`reasoningEffort`、取消和单次事件回调。`resume`、`compact`、`cancel`、`updateModel`、`inspect`、`inspectPlugins` 复用底层契约；默认 Loop 不会主动创建审批 continuation，`resume` 供具有等待能力的 Loop 使用。压缩需要配置 compaction 插件，否则返回 `skipped`。

## 预设与计划门禁

| 预设               | 默认行为                                                     |
| ------------------ | ------------------------------------------------------------ |
| `chatProfile`      | 普通问答，无计划文件门禁                                     |
| `codingProfile`    | 先检查项目，再写 `plan.md`，确认成功后允许继续修改与验证     |
| `dashboardProfile` | 保留 dashboard 示例的单文件 HTML、内联 CSS/JS 和宿主验证指令 |

有 Runner 时默认 `codingProfile`，不限于 `index.html`。自定义 `profile: { systemPrompt }` 可以关闭计划文件门禁；`profile.plan` 可以设置相对文件路径，或用宿主核实后的 `alreadyWritten` 恢复已写状态。

门禁依据工具声明的 `effects` 放行读取。其他副作用在计划写入确认前被拒绝，只有远程 `write_file` 写到计划路径可以例外放行。成功写入改变当前 Harness 的状态，失败和未知结果不会打开门禁；同批请求中的后续写入仍需等待下一轮。路径规范化兼容 `./` 和 Windows 分隔符，实际文件边界由 Runner 保证。

写入计划不代表用户审批。默认没有人类审批实现；宿主应通过 `policies` 提供审批、归属和风险规则，所有策略都必须允许操作。dashboard 的文件类型等产品限制是模型指令，不构成执行沙箱。

## 扩展

| 选项                                          | 接入方式                                                           |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `model`                                       | 现有 OpenAI 配置；或 `{ modelId, plugin }`，插件提供 `modelRouter` |
| `tools`                                       | 额外 Harness `ToolDefinition`，名称重复直接报错                    |
| `allowedTools`                                | 显式模型可见目录；默认只包含直接提供的工具，插件工具需显式加入     |
| `policies`                                    | Harness `ToolPolicy[]`，传入会话身份、输入、取消信号和执行标识     |
| `components.sessionStore`                     | 替换默认内存存储插件                                               |
| `components.context` / `toolRuntime` / `loop` | 替换对应默认能力提供者                                             |
| `plugins`                                     | 添加 Skills、MCP、压缩、遥测等插件；重复提供同一能力会报错         |
| `createContext`                               | 每次远程工具调用按需创建 SDK 上下文，可装配日志或环境适配          |

用 `components` 替换现有能力，用 `plugins` 添加能力。自定义 ToolRuntime 必须执行允许工具检查和所有 `toolPolicies`，自定义 Loop 必须遵守取消、期限和未知结果停止规则；插件是受信任的宿主代码。

`updateModel` 的参数由模型插件定义。默认 AI SDK 插件接收完整模型目录配置，而不是单个模型名；正在运行的任务保持原配置快照。默认 OpenAI 配置可声明 `images` / `files`，附件归属和真实内容校验仍由宿主负责。

回调 `onEvent` 和 `onRunResult` 是独立的最佳努力观察者，收到数据副本；同步异常或 Promise 拒绝只产生不含原异常内容的诊断，不改变运行结果。它们不等待持久化完成。可靠持久化应使用存储契约，而不是异步回调。旧 `onToolResult` 仍接收完整运行结果，旧 `planAlreadyAccepted` 兼容保留，建议改用新名称。

`close()` 并发调用共享一次清理 Promise，所有调用者都会等待结束并观察相同失败。关闭后不接受新操作；初始化失败会回收已创建的 Kernel。Runner 的生命周期始终归宿主。`session` 保留原生接口，直接使用它会绕过 Facade 的超时封顶与观察者逻辑。

## 示例与验证

```powershell
pnpm --filter @nova/coding-harness^... build
pnpm --filter @nova/coding-harness typecheck
pnpm --filter @nova/coding-harness lint
pnpm --filter @nova/coding-harness test
pnpm --filter @nova/coding-harness build
```

集成测试只替换模型与 Runner 的外部边界，使用真实 Kernel、Loop、工具运行时和策略。无需模型 API Key、真实设备或浏览器。

真实 dashboard 示例显式选择 `dashboardProfile`，使用 Rust Runner 和 Playwright CLI 验证桌面与移动端：

```powershell
$env:OPENAI_API_KEY = "..."
$env:OPENAI_BASE_URL = "https://your-openai-compatible-endpoint/v1"
pnpm example:coding-dashboard --model your-model-id
pnpm example:coding-dashboard --model your-model-id --continue <run-id>
```

产物位于 `output/coding-dashboard`，浏览器材料位于 `output/playwright`。继续已有运行要求 `plan.md` 和 `index.html` 都存在，由示例宿主确认计划写入事实。

详细设计与后续接入路线见 [架构说明](../../docs/coding-harness-architecture.md)。
