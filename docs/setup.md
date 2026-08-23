# 本地安装准备

本仓库采用一个 TypeScript `pnpm` workspace 和一个 Rust Cargo workspace。Phase 1 核心链路、浏览器协议包与 Chat 渲染包已有实现；其余应用仍按 Phase 2 推进。

## 前置工具

- Node.js `>= 22.19`
- pnpm `>= 9.15.9`（建议通过 Corepack 管理）
- Rust `>= 1.85`，包含 `cargo` 与 `rustfmt`
- Buf CLI（可由根目录的开发依赖提供）
- Protocol Buffers 编译环境（Rust `tonic-build` 后续会使用）

## 安装依赖

在仓库根目录分别执行：

```powershell
corepack enable
pnpm install
cargo fetch
```

不要手工修改 `packages/runner-sdk/src/gen/`；该目录是 Protobuf 生成产物。协议源变化后用以下命令重新生成：

```powershell
pnpm proto:generate
```

## 当前范围

- Phase 1：`agent-core`、`taskflow`、`tools`、`model-adapters`、`runner-sdk`、`proto`、Rust Runner 与集成测试。
- Phase 2 的 `protocol` 与 `chat-ui` 已实现；`agent-server`、`agent-web-ui`、`model-gateway` 和 `model-gateway-client` 尚未实现。
- `casdoor/` 和 `pi-main/` 是已有内容；前者作为共享鉴权库工作区成员，后者保留为参考项目，不纳入 Nova 的构建或改动范围。
