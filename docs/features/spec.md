# Spec 工作台

从项目会话草稿选择 Spec 模式，发送首条文本消息来创建规格及其专用会话。重新打开关联会话时会回到工作台，页面入口为 `/specs/:id`。

规格以需求、设计和任务为主线。工作台按当前阶段提供草稿生成、编辑及评审操作。已具备的操作由规格当前状态、版本和绑定会话决定。

- 查看当前规格或指定修订。提交正文和阶段评审时带上当前修订，用于服务端校验。
- 从任务清单启动单个任务的执行。查看执行尝试，记录验收证据，并提交规格验收。
- 通过导出接口读取规格快照。接口参数、权限和返回格式见 [规格路由](../../apps/nova-server/src/modules/specs/spec.routes.ts)。

实现入口见 [Spec 页面](../../apps/nova-client/src/features/specs/spec.page.tsx)、[规格服务](../../apps/nova-server/src/modules/specs/spec.service.ts) 和 [共享契约](../../packages/agent-ui-contracts/src/spec.ts)。历史设计和原始验收计划见 [SDD 首版方案](../design/nova-sdd-mode.md)。
