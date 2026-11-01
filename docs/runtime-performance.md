# 运行时性能与持久化

启动新版服务前运行 `pnpm --filter @react-fastify-template/app-server db:migrate`，应用 `0007_run_stream_positions`。迁移新增流式位置、checkpoint 元数据、checkpoint 基线版本、工具副作用状态、session commit 表，以及 pending input 组合索引。

## 流式事件

`ui_events` 是有序事实。一次 flush 在同一事务内追加事件、更新不含正文的 `runs.stream_state`，并一次推进会话游标与批次 ID。重复批次不重复追加。

`runs.projection` 是可滞后的物化基线。读取快照、恢复和非流式命令时，在事务内补放基线游标之后的 journal。累计增量达到 `max(256 KiB, 当前投影大小)` 时重新物化；接近存储上限时提前物化并验证大小。文本增长触发的全量写入随投影增大而稀疏，不跟随 50ms 定时器。

事件清理先锁会话，只删除最新可用投影游标之前的过期前缀，保护未物化事件。PostgreSQL advisory transaction lock 阻止多个进程同时清理。

## Native checkpoint

`runs.checkpoint` 与 `checkpoint_revision` 定义基线，后续 `session_commits` 按 revision 保存增量。intent、dispatched、result 三个持久化边界保留，每阶段写入自身事实，不重写原生历史。`checkpoint_metadata` 保存配置与交互等小字段，让热提交查询不必读取历史 JSONB。

SessionStore 在所属 session 内保存不可变快照，通过轻量 revision 查询识别外部修改；冲突或未确认提交使缓存失效。大小计算复用不可变子树，避免反复序列化旧消息。恢复时从基线补放提交；完整 checkpoint 替换同时推进基线版本。终态 checkpoint 物化后删除已覆盖的 commit 记录。

支持 `SessionStore.update` 的宿主在同一 owner 内串行执行增量更新，消除并行工具先读取同一 revision 再竞争提交的窗口；显式 `commit(batch, revision)` 保留严格版本校验。外部状态变化仍通过数据库 fence、revision 和必要重试处理。

空 steering 查询不写数据、不增加 revision，已预留输入不会再次预留。副作用状态单独保存在小字段中，环境检查无需扫描历史 execution JSON。

## 调度与界面

`WORKER_CONCURRENCY` 控制每个 Worker 的会话执行槽位，默认 4，范围 1–64。只领取空闲槽位能立即执行的任务，每个任务独立续租，完成后确认；关闭时停止领取并等待在途任务。部署时结合实例数和数据库连接池设置该值。

watchdog 每秒只查询运行状态、目标状态和续租所需字段。会话快照读取投影与交互元数据，不读取完整 checkpoint。

公共运行时入口 `features/runs/runtime.ts` 只加载协议状态与连接管理。每个事件立即校验并推进协议状态，会话页仅在帧发布后转换展示数据；展示代码随路由加载。转换缓存以不可变消息和 block 为键，工具状态改变只使相关工具消息失效。消息列表稳定回调并复用工具结果配对对象，未变化的历史 Markdown、代码块不随文本增量重绘。
