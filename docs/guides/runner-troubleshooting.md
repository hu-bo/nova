# Runner 连接与排障

Runner 从注册工作区所在设备发起 WebSocket 连接，使用 Protobuf 帧。安装和令牌启动命令见 [Runner 安装](../../packages/runner/README.md)，反向代理配置见 [部署说明](deployment.md#服务器与反向代理)。

## 常见问题

| 现象 | 核对项 |
| --- | --- |
| 设备持续离线 | 检查 Runner 进程、连接令牌和服务端记录。连接地址使用 `ws://` 或 `wss://`，路径为 `/runner/v1/connect`。生产反向代理需支持 WebSocket Upgrade。 |
| 已在线但项目无法使用 | 检查项目绑定的设备、工作区和项目目录。Runner 启动时要求工作区目录存在。只读工作区的写操作会被拒绝。 |
| 执行时断线 | 同一个 Runner 进程在传输断开后可以继续已接收的操作。重连后服务端按 `boot_id` 和操作 ID 对账。 |
| 结果未知 | Runner 重启或回执已经丢失时，服务端可能无法确认结果。先查看工作区和外部系统是否已发生变更，再决定是否重新提交。 |
| 并发已满、命令超时或取消 | 检查 Runner 的执行槽位和操作最终状态。Runner 并发默认 4，可通过 `--max-concurrency` 在 1–64 内配置。此值和服务端的 `WORKER_CONCURRENCY` 分别控制设备操作和会话调度。 |

## 实现入口

- [连接、心跳和重连](../../crates/runner/src/main.rs) · [启动参数](../../crates/runner/src/config.rs)
- [命令、文件操作和回执](../../crates/runner/src/engine.rs) · [工作区路径校验](../../crates/runner/src/workspace.rs)
- [服务端连接与注册](../../apps/nova-server/src/modules/runners/) · [SDK 对账](../../packages/runner-sdk/src/session.ts) · [协议定义](../../proto/runner/v1/runner.proto)

旧版 gRPC 的功能与故障处理见 [历史记录](../archive/runner-features-and-error-handling.md)。
