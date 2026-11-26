# 会话与项目环境

## 创建和运行会话

- 从侧栏「新建 Chat」开始普通会话，从项目旁的加号开始项目会话。发送第一条消息后创建会话。项目会话使用该会话绑定的环境。
- 每条消息可以选择模型与推理强度。运行期间的普通输入会进入队列，并可在执行前撤回。后端支持 steering 时，可将已排队的纯文本改为「调整方向」，在后续模型步骤中生效。
- 输入框提供 Plan、Build 和 Auto。Plan 使用只读工具，Build 在修改和执行命令时要求确认，Auto 按后端的自动放行策略执行。可以用 `/plan`、`/build` 或 `/auto` 设置模式。
- 历史消息可以向前翻页。会话支持重命名、清除上下文和删除。清除上下文会重置后续运行使用的上下文，历史消息仍可阅读。
- 图片上传需要服务端配置对象存储，并使用支持图片输入的模型。项目环境提供文件选择时，也可以引用远程文件。
- 会话以快照和 SSE 显示运行进度。取消与审批通过运行接口提交，重连后使用服务端事件和快照继续展示。

## Goal 与 Spec

输入 `/goal 目标内容` 或使用目标按钮后发送消息。目标面板支持查看完成标准和轮次限制，以及暂停、继续、标记完成或移除。Agent 使用 `finish_goal` 提交完成。达到轮次上限、取消或执行失败时会暂停自动推进。

需要先评审需求和方案时，从项目会话草稿进入 [Spec 工作台](spec.md)。需要在一条消息中选择技能或查看文件交付时，见 [Skills 与产物](skills.md)。

## 绑定 Runner 和 SSH

- Runner 的安装和令牌启动步骤见 [Runner 安装](../../packages/runner/README.md)。在工作台设置中创建连接令牌，再在项目设置选择设备和工作目录。连接问题见 [Runner 排障](../guides/runner-troubleshooting.md)。
- 在「设置 → SSH 远程」添加连接，填写主机、端口、用户名、工作目录和认证信息。测试连接时核对主机指纹，保存后在项目设置绑定连接。
- SSH 目录选择从 `/` 开始，可见范围取决于 SSH 帐号权限。已配置工作目录用于解析已有的相对路径。文件变更导致原附件摘要失效时，需要重新选择文件。现有加密凭据依赖服务端配置中的原密钥，配置见 [部署说明](../guides/deployment.md#配置中心与数据库)。

## 实现入口

| 行为 | 工作台 | 服务端 |
| --- | --- | --- |
| 提交、队列和 Goal | [会话功能](../../apps/nova-client/src/features/conversations/) | [会话路由](../../apps/nova-server/src/modules/conversations/conversation.routes.ts) · [附件模块](../../apps/nova-server/src/modules/attachments/) |
| 事件、取消和审批 | [运行投影](../../apps/nova-client/src/features/runs/) | [事件模块](../../apps/nova-server/src/modules/events/) · [运行路由](../../apps/nova-server/src/modules/runs/run.routes.ts) |
| 项目环境与远程连接 | [项目功能](../../apps/nova-client/src/features/projects/) | [项目绑定](../../apps/nova-server/src/modules/projects/project-binding.service.ts) · [SSH 连接](../../apps/nova-server/src/modules/remotes/) |

共享组件的接入方式见 [Chat UI](../../packages/chat-ui/README.md)，聊天协议的重构过程见 [迭代记录](../archive/chat-protocol-optimization-plan.md)。
