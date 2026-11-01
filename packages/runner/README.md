# @nnova/runner

分发 `crates/runner` 的 Rust 可执行文件。沿用 nova 的 npm 包名、命令、Release 资产名称和安装方式，支持 Linux x64、macOS x64 / arm64、Windows x64。

当前 Runner 使用 WebSocket。`--server` 必须是完整的 `ws://` 或 `wss://` 地址，例如 `wss://nova-grpc.8and1.cn/runner/v1/connect`，不能继续使用旧 gRPC Runner 的 HTTP 地址。

## npm 安装与运行

```bash
npx --yes --package @nnova/runner nova-runner \
  --server 'wss://nova-grpc.8and1.cn/runner/v1/connect' \
  --token '<runner-token>' \
  --workspace '/path/to/project'
```

也可以 `npm install -g @nnova/runner`，之后直接执行 `nova-runner`。npm 包只选择和启动对应平台的二进制，不需要在用户设备上编译 Rust。

可通过 `NOVA_RUNNER_BIN` 指定自定义二进制；其余参数和 TOML 配置见 [Runner 文档](../../crates/runner/README.md)。

## Windows 安装器

在当前仓库的 GitHub Release 下载 `nova-runner-setup.exe`，填写 WebSocket 地址、Token 和已有的 workspace 目录。安装器立即在后台启动 Runner，并注册当前用户登录时自动运行的 `Nova Runner` 计划任务，卸载时移除任务和配置。

安装目录为 `%LOCALAPPDATA%\Programs\Nova Runner`，配置保存到 `%LOCALAPPDATA%\Nova Runner\config.toml`。

## Linux systemd 安装

将 `RELEASE_URL` 设为当前仓库的 Release 下载地址：

```bash
RELEASE_URL='https://github.com/<owner>/<repo>/releases/latest/download'
curl -fsSL "$RELEASE_URL/install-runner.sh" | sh -s -- \
  --server 'wss://nova-grpc.8and1.cn/runner/v1/connect' \
  --token '<runner-token>' \
  --workspace "$HOME/project"
```

发布时脚本内的默认下载地址会自动指向当前 GitHub 仓库；如需固定版本或镜像，可用 `NOVA_RUNNER_RELEASE_URL` 覆盖。以普通用户执行，需有 sudo 权限；脚本校验 SHA-256 后，将 binary 安装到 `/usr/local/bin/nova-runner`，配置写入 `/var/lib/nova-runner/config.toml`，安装并启动 `nova-runner.service`。服务以发起安装的普通用户运行并随系统启动。

Linux 产物沿用 Rocky Linux 9 上构建的 `x86_64-unknown-linux-gnu`，要求 glibc 2.34+，不使用 musl，以保留参考流程已经验证过的 DNS 解析行为。可用 `getconf GNU_LIBC_VERSION` 检查版本。

## 打包发布

`.github/workflows/runner-release.yml` 在推送 `runner-v*` 标签时运行，需配置有 `@nnova/runner` 发布权限的 `NPM_TOKEN` secret。使用尚未在 npm 发布过的版本号：

```bash
git tag runner-v1.0.0
git push origin runner-v1.0.0
```

GitHub Release 和 npm 使用相同的四个平台构建产物。Linux 构建会检查 `ldd` 的动态 libc 依赖、缺失库，并运行 `--help`。macOS x64 固定使用 `macos-15-intel`，macOS arm64 使用 `macos-14`，Windows x64 使用 `windows-latest`。Windows 安装包使用 Inno Setup，保留原 AppId 和计划任务名称。

Release 包含以下资产：

- `nova-runner-linux-x64.tar.gz`
- `nova-runner-darwin-x64.tar.gz`
- `nova-runner-darwin-arm64.tar.gz`
- `nova-runner-setup.exe`
- `install-runner.sh`
- `SHA256SUMS`

`@nnova/runner` 内含四个平台 binary。`prepack` 会检查产物齐全，防止发布缺少平台的 npm 包。`vendor/` 为生成目录，不提交到 Git。

本地可构建并暂存单个平台：

```powershell
cargo build -p nova-runner --locked --release
$env:NOVA_RUNNER_BINARY = (Resolve-Path 'target/release/nova-runner.exe').Path
$env:NOVA_RUNNER_TARGET = 'win32-x64'
pnpm --dir packages/runner stage
pnpm --dir packages/runner typecheck
```

发布前必须暂存全部四个平台；各平台源文件均通过 `NOVA_RUNNER_BINARY` / `NOVA_RUNNER_TARGET` 指定。不要将旧 nova 的 gRPC binary 混入新版本。
