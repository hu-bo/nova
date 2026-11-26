# Skills 与文件产物

## 查找和选择技能

打开「我的技能」页面（`/skills`），可以搜索、按来源筛选并查看技能详情和适用条件。默认范围显示当前用户的平台技能和可见内置技能。选择设备可以看到该 Runner 的全局技能，选择项目则按项目绑定的 Runner 和工作目录查找。

| 来源 | 维护入口 |
| --- | --- |
| 内置 | 随 [Nova 工具包](../../packages/tools/skills/) 交付，例如求职教练和技能创建助手 |
| 平台 | 服务端有草稿保存、发布、版本查询和停用接口。当前「我的技能」页面提供浏览和会话预选，网页管理表单尚未接入 |
| Runner 全局 | Runner 所在机器的 `~/.nova/skills/<name>/SKILL.md` |
| Runner 项目 | 绑定项目目录下的 `.nova/skills/<name>/SKILL.md` |

在页面点击「在会话中使用」，或在输入框选择技能，即可为一次普通输入指定一个技能及版本。发送后，服务端会判断技能是否适用于当前环境和模式，并在接受输入时固定版本与正文。切换技能不会自动切换执行模式。需要写入工作区的技能在只读模式下会被拒绝。

「创建技能」在会话草稿中预选内置助手，发送后开始执行。修改本地技能后，可在所选设备或项目上下文中点击「刷新本地技能」。设备离线、目录过期和扫描结果为空在界面上分别提示。

Runner 也能发现本机或项目的 `.nova/agents/<name>.md`。Agent 配置从输入框的独立入口选择，是否可用由会话类型和服务端校验决定。当前可选的本地 Agent 用于 Nova 后端的纯文本普通会话，带 SSH 环境、Goal 或附件的输入不适用。见 [Agent 目录](../../apps/nova-server/src/modules/skills/skill.routes.ts) 和 [执行准入](../../apps/nova-server/src/modules/runs/agent-profile.ts)。

## 查看文件产物

启用了 MinIO 且绑定 Runner 的 Run，可在允许写入的模式下发布本次工作区生成的文件。Agent 将文件写入本次 Run 的输出目录，再调用 `artifact_publish`。SSH 项目的通用文件发布仍属于待实现范围。

会话的产物区显示文件名、大小、发布状态及来源 Run。发布完成后可下载。可预览类型还会提供预览入口。服务端按会话和运行的归属检查访问权限。

## 实现与设计

- [技能列表页面](../../apps/nova-client/src/features/skills/skills.page.tsx) · [技能接口](../../apps/nova-server/src/modules/skills/skill.routes.ts) · [Runner 本地资源扫描](../../crates/runner/src/local_resources.rs)
- [产物面板](../../apps/nova-client/src/features/artifacts/artifacts-panel.tsx) · [产物读取接口](../../apps/nova-server/src/modules/artifacts/artifact.routes.ts)
- [原始设计](../design/nova-skills.md) · [实施任务和历史验收](../design/nova-skills-todo.md)
