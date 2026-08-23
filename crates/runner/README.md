# crates/runner — nova-runner

Execution Plane：Rust Runner 主动连接 runner-sdk 的持久双向 gRPC 流，在该连接上处理
`Execute → Cancel → 文件操作`。用户机器不开放 Runner 入站端口。
设计契约见 [docs/runner.md](../../docs/runner.md)(结构 / 状态机 / 边界)与
[docs/proto.md](../../docs/proto.md)(gRPC 消息定义)——本文件只讲"怎么跑起来",不重复那两份文档。

## 构建 / 运行 / 测试

```bash
cargo build -p nova-runner            # 产物在 target/debug/nova-runner(.exe)
cargo test  -p nova-runner            # 路径越界(含符号链接)、并发/队满、超时、cancel 杀进程 4 组单测
cargo clippy -p nova-runner --all-targets
```

### 三端构建可执行文件

在对应操作系统上执行 release 构建：

Linux：

```bash
cargo build -p nova-runner --release
./target/release/nova-runner --version
```

macOS：

```bash
cargo build -p nova-runner --release
./target/release/nova-runner --version
```

Windows PowerShell：

```powershell
cargo build -p nova-runner --release
.\target\release\nova-runner.exe --version
```

产物分别是 `target/release/nova-runner` 和
`target\release\nova-runner.exe`。npm 发布包的三端二进制由
`.github/workflows/runner-release.yml` 在 Linux、macOS、Windows runner 上分别构建后合并。

### 安装可执行包

需要在 macOS、Windows 或 Linux 上直接运行时，推荐安装发布包：

macOS / Linux：

```bash
pnpm add -g @nova/runner
npx nova-runner --server http://127.0.0.1:50051 --token <runner_token> --workspace /path/to/project
```

Windows PowerShell：

```powershell
pnpm add -g @nova/runner
nova-runner.exe --server http://127.0.0.1:50051 --token <runner_token> --workspace E:\Project\my-project
```

更新已安装的 Runner：

```bash
pnpm update -g @nova/runner
nova-runner --version
```

`@nova/runner` 只分发并启动本 crate 构建出的 `nova-runner`，不包含第二套执行实现。
支持 Linux x64、macOS x64/arm64 和 Windows x64；本地开发仍可直接使用下面的 Cargo
命令。若使用自定义构建，可设置 `NOVA_RUNNER_BIN` 覆盖已发布的二进制。

跑起来(workspace 必须已存在,不会自动创建):

```bash
target/debug/nova-runner \
  --server http://127.0.0.1:50051 \
  --token local-connection-token \
  --workspace /path/to/project
```

本地开发时必须把 Runner 参数放在 Cargo 的双横线之后，否则参数会被 Cargo 自己解析：

~~~bash
cargo run -p nova-runner -- \
  --server http://127.0.0.1:50051 \
  --token <agent-web-ui 中显示的 runner_token> \
  --workspace /path/to/project
~~~

PowerShell：

~~~powershell
cargo run -p nova-runner -- --server http://127.0.0.1:50051 --token <runner_token> --workspace E:\Project\my-project
~~~

agent-server 本地需保持 RUNNER_PORT=50051，远程部署时用 RUNNER_HOST=0.0.0.0
监听并把 RUNNER_PUBLIC_URL 设置成 Runner 能访问的公网 HTTP 或 HTTPS 地址。

## CLI 参数

| 参数 | 缺省 | 说明 |
|---|---|---|
| `--server` | 必填 | runner-sdk 的 `http://` 或 `https://` 地址 |
| `--token` | 必填 | 作为 `authorization: Bearer ...` 元数据发送的连接令牌 |
| `--runner-id` | 主机名 + workspace 哈希 | 稳定 Runner ID；同一 workspace 重启后保持不变 |
| `--workspace` | 当前目录 | 目录不存在则拒绝启动 |
| `--max-concurrency` | CPU 核数 | 同时 `running` 的执行数上限 |
| `--queue-size` | `4 × max-concurrency` | 排队等待的执行数上限,超出立即返回 `BUSY` |
| `--default-timeout-ms` | `120000` | 请求未指定 `timeout_ms` 时使用 |

## 目录结构

```text
src/
├── main.rs / config.rs   # CLI、启动期校验
├── connection.rs         # 出站连接、Register/Heartbeat、重连与断连收口
├── protocol.rs           # Connect 流内消息路由和请求关联
├── pb.rs                 # `tonic::include_proto!` 生成绑定的落点
├── execution/            # 状态机 + 并发调度 + 输出分块
├── process.rs            # spawn / 跨平台杀进程树
└── workspace/            # 路径解析越界拒绝、文件操作、grep
```

## 集成测试

`tests/integration/` 先让 `@nova/runner-sdk` 在 loopback 随机端口监听，再 spawn 这里
编译出的真实二进制（`target/debug/nova-runner`）出站连接，不是 mock。二进制优先使用
`NOVA_RUNNER_BIN`，否则按仓库根目录拼 `target/debug`。
