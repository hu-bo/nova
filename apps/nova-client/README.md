# Nova Client

基于 React 19、Vite、TanStack Router / Query、HeroUI 和共享 `@nova/chat-ui` 的 AI 工作台。实现依据为 `docs/nova-client.md`。

## 启动

在仓库根目录执行：

```powershell
pnpm install
pnpm --filter @nova/casdoor build
pnpm --filter @react-fastify-template/app-server dev
pnpm --filter @react-fastify-template/app-web dev
```

前端地址为 `http://127.0.0.1:8003`。后端需要配置 PostgreSQL 并执行现有迁移；前端没有内置业务演示数据。复制本目录 `.env.example` 后配置公开 API / SSE / Auth Service 地址。开发代理默认指向 `http://127.0.0.1:3000`，可通过 `API_PROXY_TARGET` 调整。生产部署需要同源代理 `/api`、`/health`，或配置允许浏览器访问的公开地址。

本地开发登录令牌只存在内存，刷新页面后重新登录。生产构建剔除开发登录；开发期流诊断（连接状态变化、订阅错误、事件校验/快照重建异常）仅输出到浏览器控制台，不占用界面。正式登录使用 `@nova/casdoor/client/react`，采用 SDK 管理的内存令牌、刷新、回调和退出流程；跨标签页退出会广播身份变化。

## 当前功能

- 普通 / 项目会话、第一条消息创建会话、历史消息分页、重命名、删除、清空上下文、后续输入队列和撤回。
- 按身份隔离的 Query cache 和按身份 / 会话保存的文字草稿。只在服务端接受提交后清空草稿。
- Bearer fetch SSE、断线退避、心跳超时、401 刷新、429 等待、410 快照重建；v2 事件的去重、连续游标、revision / epoch 检查、流式内容与完整提交的替换、审批、取消、未知结果、TODO、只读子任务和有界工具日志。v1 基础文本与工具事件显示降级提示。
- 项目 CRUD、设备与相对工作目录绑定、项目指令保存、环境版本校验；已有项目会话冻结原环境。
- 设备在线状态、连接凭据创建 / 轮换 / 撤销、仅显示一次的 secret、能力允许时的远程文件浏览。
- 图片直传队列（最多三个并发）、校验后生成附件元数据、失败重试 / 移除；项目附件引用远程文件摘要；图片通过授权签名 URL 预览并刷新。
- 响应式导航、菜单搜索、深浅色 / 跟随系统、减少动画、服务健康提示和模型目录只读占位。

## 服务端尚未就绪的能力

当前仓库的 Agent worker 没有执行器，取消 / 决策端点仍是占位实现，上传地址和远程目录仍是测试实现，生产身份验证器也尚未接通。新增 `/api/v1/config` 如实返回 `execution/uploads/remoteFiles/compression/models = false`；界面不会展示假的执行、上传或远程访问成功。不要仅把这些开关改为 true，需先完成对应服务端适配器、鉴权和端到端验证。

模型目录、模型 / 推理强度修改、配额、上下文压缩及浏览器诊断上报仍需后端补齐契约和能力。客户端使用服务端默认模型，不保存 Provider secret，不直接调用模型供应商。

本次后端配套变更包括真实历史分页、标题 / 删除 / 清空接口、项目 binding 读取和版本化保存、会话初始消息的原子写入、创建 / 输入命令幂等、输入撤回的归属与状态检查，以及持续读取已持久化 SSE 事件。没有新增数据库结构。

## 验证

```powershell
pnpm --filter @react-fastify-template/app-server openapi:export
pnpm --filter @react-fastify-template/app-web api:generate
pnpm --filter @react-fastify-template/app-web api:check
pnpm --filter @react-fastify-template/app-web routes:check
pnpm --filter @react-fastify-template/app-web check:boundaries
pnpm --filter @react-fastify-template/app-web lint
pnpm --filter @react-fastify-template/app-web format:check
pnpm --filter @react-fastify-template/app-web test
pnpm --filter @react-fastify-template/app-web build
```

`orval.config.ts` 从 `../nova-server/openapi.json` 生成 REST DTO 与客户端，transport 解开成功信封并统一错误。`src/api/generated` 与 `src/routeTree.gen.ts` 均只通过生成器更新。

`build` 包含类型检查、生产构建、入口和会话首页的 300 KiB gzip 预算检查，以及开发界面剔除检查。代码 / Diff / 消息查看器按需加载。`tests` 覆盖事件投影、SSE、请求刷新与身份隔离、提交意图、上传和输入交互；详细交付与验证边界见 `docs/nova-client-implementation.md`。
