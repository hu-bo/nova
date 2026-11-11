# Nova 代码扫描与重构记录

日期：2026-11-12。

本轮使用模型插件、前端、服务端三个专家 agent 分区检查，由主 agent 集成和复核。开始时 `configured-model.ts` 与 `streaming.test.ts` 已有的“上游返回 finish 后可以不带 `[DONE]`”修复，在共享适配器及两层回归测试中保留。

## 检查范围

- 对 `apps/`、`packages/`、`demo/`、`scripts/` 的 510 个非生成 TypeScript/TSX 文件进行 AST 结构扫描，排除测试、生成代码、构建产物和依赖目录；按照候选继续检查调用方与失败路径。
- 前端重点检查 SSE、会话快照、附件队列、运行状态、远程文件选择和管理台表单；运行两个前端包的边界检查。
- 服务端重点检查模型配置、运行与 UI 投影、规格任务、事务和数据访问边界；共享框架检查模型、工具、任务流与取消状态。
- Runner 阅读配置、工作区、摘要、握手重连、幂等、取消和子进程清理关键路径，没有修改 Rust 或协议生成物。

结构扫描不能替代所有业务的逐行审查；本轮针对有实际证据的职责重复、生命周期竞争和输入边界修改，没有按文件长度机械拆分模块。

## 职责归属

| 功能                                      | 实现位置                                                               | 约束                                           |
| ----------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| 供应商目录、协议选择、推理参数            | `packages/harness/src/plugins/model-ai-sdk/catalog.ts`、`providers.ts` | 注册表检查供应商覆盖；供应商差异不进入业务分支 |
| 模型请求、流、usage、工具调用、错误、取消 | 同插件 `index.ts`、`transport.ts`                                      | 共用 AI SDK 单步流；不维护另一套 SSE 解析器    |
| 原生续写、签名、旧历史转换                | 同插件 `messages.ts`、标准消息块 metadata                              | 签名留在内部消息；UI 只投影公开字段            |
| 密钥加解密、配置权限、模型可用性          | `apps/nova-server/src/modules/model-config/`                           | 业务规则仍由服务管理；协议从共享目录派生       |
| 私有图片地址与存储归属                    | `runs/configured-model.ts`、attachments 模块                           | 宿主提供解析回调；共享模型包不依赖 Nova 存储   |
| 控制台供应商选项                          | 服务端目录接口 → OpenAPI → Orval → 表单                                | 前端不复制供应商默认地址或参数映射             |
| 模型实际能力、价格和容量                  | 模型配置                                                               | 供应商支持某种参数不代表其每个模型都具备该能力 |
| 网络会话与取消                            | `RunStreamManager`、`SseConnection`、`UploadQueue`                     | 生命周期只有一个 owner；旧响应不能覆盖新会话   |
| 事务、权限、规格业务规则                  | `SpecService`                                                          | Service 编排事务；读取 SQL 已迁入 Repository   |
| 最新执行记录读取                          | `spec-read.repository.ts`                                              | 按任务批量查询；Repository 不自行开启事务      |
| 运行失败状态                              | Harness `contracts/errors.ts`                                          | Kernel 与 Agent Loop 使用相同的取消/超时优先级 |

## 本轮落地

### 模型与管理台

- Nova 运行入口统一调用 `aiSdkModelPlugin`。原业务适配器约 500 行缩为配置、日志和附件解析的绑定代码。
- OpenAI、OpenAI Compatible、Anthropic、DeepSeek、MiniMax 两种协议的差异由共享插件处理，自定义 Base URL 保留。
- 统一 Thinking 等级到 provider 参数的映射：例如 DeepSeek 的 `medium` 映射到其支持的 `high`；MiniMax 不声明 `off`，请求时明确拒绝不支持的等级。
- Anthropic 签名随对应消息块保存并回放。旧 `anthropicContent`、`reasoningContent` 只在共享兼容边界解释。
- UI 投影保持每个 Thinking 块的标识，不输出 opaque metadata。
- 新增供应商目录接口。控制台不再手工组合“协议”和“Reasoning 格式”，并保留异步加载前输入的地址和密钥。
- 可用模型目录会过滤旧配置中供应商不支持的 Thinking 等级；无效 URL 返回校验错误，不从 URL 解析器抛成服务端异常。
- `model_providers.adapter_id` 为 nullable。旧配置继续按原模型格式解析，不猜测或批量覆盖已有数据。绑定模型的连接禁止切换适配器或协议；同适配器更换网关地址仍可使用。
- `api:sync` 从服务端 schema 更新管理接口并生成客户端，保留暂未迁移的旧用量接口契约。保留契约不代表用量后端已经实现。

### 生命周期与状态

- 流会话按实例检查所有权，旧释放微任务不会删除同 ID 的新会话；旧快照完成后也不会清理新请求。
- SSE 在网络读取返回后再次检查取消，关闭连接后不再分发迟到帧。
- 上传并发数从当前 controller 集合派生。撤销或删除后不再申请下一阶段，重试仅接受失败项。
- 运行状态的文案与颜色放在同一张穷尽类型的表中；远程文件选择仅接收实际需要的 modifier keys。
- Kernel 与 Basic Loop 共用失败状态判定；工具错误、流程 join 和结束状态用明确分支表达原有优先级。

### 规格、工具与配置

- 规格详情、依赖检查和验收使用批量最新 attempt 查询，消除逐任务 N+1 查询；证据是否有效共用一个规则。
- 证据输入类型从已有 schema 推导，移除业务 `any`；规格列表及执行历史的读取查询移至 Repository。
- 工具与 Runner SDK 清理五处嵌套三元，保持错误映射及截断优先级。
- 全套服务端测试发现已有认证配置兼容回归：恢复 `CASDOOR_ENDPOINT` 作为旧别名，并保持显式 `AUTH_SERVICE_URL` 优先。

## 验证与交付约束

| 检查                           | 结果                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------ |
| Harness 全套测试               | 45 项通过                                                                                        |
| nova-server 全套串行测试       | 98 项通过，2 项数据库集成跳过                                                                    |
| model-console 全套测试         | 61 项通过                                                                                        |
| nova-client / chat-ui 相关回归 | 5 个测试文件、38 项通过                                                                          |
| coding-harness                 | 18 项通过                                                                                        |
| 类型检查                       | server、console、client 现有源码、chat-ui、harness、tools、runner-sdk、coding-harness、Demo 通过 |
| 构建                           | Harness、tools、runner-sdk、model-console 通过                                                   |

model-console 生产构建仍报告 CSS 选择器压缩警告与大于 500 kB 的 chunk 警告，构建退出码为 0。本轮没有升级 UI 依赖或修改全局样式。

- Harness 的模型、Agent、任务流、工具、取消与 Coding 场景测试，以及相关包的类型、构建、lint 和边界检查。
- nova-client 的 SSE、上传、会话流、运行面板及 chat-ui 文件选择回归；现有源码 TypeScript 检查没有重新生成客户端 API。
- nova-server 整套测试使用 `--test-concurrency=1`，避免本机并发 Node 进程耗尽内存；数据库集成需要专用 `TEST_DATABASE_URL`。
- 管理台测试、类型与 lint；新管理契约和服务端定义逐项对照，重复同步应产生相同文件。
- 新迁移是 `database/migrations/0010_model_provider_adapters.sql`，部署时按正常迁移流程执行；本轮不连接业务数据库应用迁移。
- 没有进行真实供应商调用、真实 SSO 登录或 Runner 端到端网络验收。

## 后续架构审查方向

- `SpecService` 仍承载较多写查询。下一阶段可在保留事务 owner 的前提下，将写入移入规格 Repository，并把规格表补入架构规则的 ownership 清单；需要数据库集成验证。
- `useConversationComposer`、`ConversationWorkspace`、`SpecWorkbench` 同时处理多种交互。应按实际变化轴和状态 owner 决定是否拆分，不能只按行数增加转发层。
- Demo 和示例仍有局部复杂表达式，基础 DI、管理 SDK 也有少量基础设施类型边界；本轮没有把它们视为与已确认的业务竞争同等优先级的问题。
