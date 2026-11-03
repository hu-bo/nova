# @nnova/runner

分发 [`crates/runner`](../../crates/runner) 的 Rust 可执行文件。npm 包提供 `nova-runner` 命令，根据当前操作系统和 CPU 架构启动包内对应的二进制，并透传命令行参数。运行 npm 包需要 Node.js 18+，无需本机编译 Rust；直接运行二进制或使用安装器不需要 Node.js。

| 平台        | npm 包内目录          | 二进制文件        |
| ----------- | --------------------- | ----------------- |
| Linux x64   | `vendor/linux-x64`    | `nova-runner`     |
| macOS x64   | `vendor/darwin-x64`   | `nova-runner`     |
| macOS arm64 | `vendor/darwin-arm64` | `nova-runner`     |
| Windows x64 | `vendor/win32-x64`    | `nova-runner.exe` |

Linux 产物在 Rocky Linux 9 上构建，目标为 `x86_64-unknown-linux-gnu`，需要 glibc 2.34+ 及二进制依赖的动态库。可用 `getconf GNU_LIBC_VERSION` 检查 glibc 版本，用 `ldd /path/to/nova-runner` 检查缺失的库。

## 快速运行

先进入要交给 Runner 使用的项目目录，再执行以下命令。该单行写法适用于 PowerShell 和 Bash：

```shell
npx --yes --package @nnova/runner nova-runner --server 'wss://<你的服务域名>/runner/v1/connect' --token '<runner-token>'
```

在 Nova 首页登录后，可直接复制带实际连接地址和有效 Runner Token 的命令；没有可用 Token 时，先到设备管理中创建或轮换凭据。这里使用的是 Runner Token。

`--server` 必须使用完整的 `ws://` 或 `wss://` 地址。当前 Runner 使用 WebSocket，不能使用旧 gRPC Runner 的 HTTP 地址。本地服务地址示例为 `ws://127.0.0.1:9203/runner/v1/connect`，实际端口以服务端配置为准。

未通过参数、环境变量或 TOML 配置指定 workspace 时，Runner 使用启动时的当前目录。也可以显式追加 `--workspace '/path/to/project'`，或用 `--workspace .` 覆盖环境变量和 TOML 中的工作目录。目录必须已经存在。

全局安装后也可直接运行：

```shell
npm install -g @nnova/runner
nova-runner --server 'wss://<你的服务域名>/runner/v1/connect' --token '<runner-token>'
```

以上方式在当前终端运行，不会注册自启动任务。`NOVA_RUNNER_BIN` 可覆盖 npm 启动器选择的二进制路径；平台不受支持或二进制不可执行时，启动器会报错退出。

## 参数与配置

配置解析见 [`crates/runner/src/config.rs`](../../crates/runner/src/config.rs)。普通配置项的优先级为：命令行参数 > 对应环境变量 > TOML 配置 > 默认值。TOML 文件需要通过 `--config` 或 `NOVA_RUNNER_CONFIG` 显式指定。

| 参数                | 环境变量                      | 默认值或要求                                                                              |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------- |
| `--config`          | `NOVA_RUNNER_CONFIG`          | 可选，TOML 文件路径                                                                       |
| `--server`          | `NOVA_RUNNER_SERVER`          | 必填，WebSocket 连接地址                                                                  |
| `--token`           | `NOVA_RUNNER_TOKEN`           | 必填，非空 Runner Token                                                                   |
| `--workspace`       | `NOVA_RUNNER_WORKSPACE`       | 当前目录 `.`，必须为已有目录                                                              |
| `--workspace-id`    | `NOVA_RUNNER_WORKSPACE_ID`    | `default`                                                                                 |
| `--display-name`    | `NOVA_RUNNER_DISPLAY_NAME`    | 与 workspace ID 相同                                                                      |
| `--runner-id`       | `NOVA_RUNNER_ID`              | `<主机名>:<workspace-id>`；主机名依次取 `COMPUTERNAME`、`HOSTNAME`，均未设置时取 `runner` |
| `--max-concurrency` | `NOVA_RUNNER_MAX_CONCURRENCY` | `4`，允许范围为 `1–64`                                                                    |
| `--read-only`       | `NOVA_RUNNER_READ_ONLY`       | 默认 `false`；CLI 解析结果或 TOML 为 `true` 时启用                                        |

`read_only` 使用合并逻辑：即使环境变量为 `false`，也不能覆盖 TOML 中的 `read_only = true`。TOML 不接受未知字段。

例如，将以下内容保存为 `runner.toml`：

```toml
server = "wss://<你的服务域名>/runner/v1/connect"
token = "<runner-token>"
workspace_id = "my-project"
runner_id = "my-device"
max_concurrency = 4
read_only = false
```

```shell
nova-runner --config runner.toml
```

此例未设置 `workspace`，也未设置对应参数或环境变量时，使用执行命令时的当前目录。配置中的相对路径也相对于进程当前目录解析。更多运行行为见 [Runner 文档](../../crates/runner/README.md)。

## Windows 安装器

从 [GitHub Releases](https://github.com/hu-bo/nova/releases) 下载 `nova-runner-setup.exe`，填写 WebSocket 地址、Runner Token 和 workspace 根目录。workspace 默认预填 `%USERPROFILE%`，可以改为其他已有目录。

安装器使用当前用户权限，将程序安装到 `%LOCALAPPDATA%\Programs\Nova Runner`，并把连接配置写入 `%LOCALAPPDATA%\Nova Runner\config.toml`。

安装完成后注册名为 `Nova Runner` 的计划任务，立即在后台启动，并在当前用户登录时自动运行。它是当前用户的登录任务，不是 Windows 系统服务。卸载时移除计划任务及配置文件。

## Linux systemd 安装

安装脚本支持 Linux x64，需要 systemd、sudo 和脚本所用的下载、解压、校验工具。以普通用户执行；通过 sudo 执行时，脚本会以 `SUDO_USER` 指定的用户作为 Runner 所有者，不支持没有 `SUDO_USER` 的直接 root 安装。

以下命令应在 Bash 或 POSIX shell 中执行：

```bash
RELEASE_URL='https://github.com/hu-bo/nova/releases/latest/download'
curl -fsSL "$RELEASE_URL/install-runner.sh" | sh -s -- \
  --server 'wss://<你的服务域名>/runner/v1/connect' \
  --token '<runner-token>'
```

安装脚本不传 `--workspace` 时使用运行用户的主目录，并将其写入 TOML；这与直接运行 Runner 默认使用当前目录的行为不同。要使用项目目录，可在安装参数中追加 `--workspace "$PWD"` 或其他已有目录的绝对路径。脚本也接受可选的 `--runner-id '<设备 ID>'`。

脚本下载 Linux 压缩包和 `SHA256SUMS`，校验二进制压缩包的 SHA-256，然后写入：

| 内容         | 路径                                      |
| ------------ | ----------------------------------------- |
| 二进制       | `/usr/local/bin/nova-runner`              |
| 配置         | `/var/lib/nova-runner/config.toml`        |
| systemd 单元 | `/etc/systemd/system/nova-runner.service` |

配置目录权限为 `700`、配置文件权限为 `600`，归运行用户所有。服务以该用户身份运行，立即启动并随系统启动；进程异常退出后等待 5 秒重启。

```bash
sudo systemctl status nova-runner
sudo journalctl -u nova-runner -f
```

发布流程会将分发脚本的默认下载地址替换为当前 GitHub 仓库。源码脚本中的默认地址仍为 `hu-bo/nova-dsh`；直接运行源码脚本或使用固定版本、镜像时，可通过 `NOVA_RUNNER_RELEASE_URL` 覆盖二进制和校验文件的下载地址。通过管道执行时，应将变量传给 `sh`：

```bash
curl -fsSL "$RELEASE_URL/install-runner.sh" | \
  NOVA_RUNNER_RELEASE_URL="$RELEASE_URL" sh -s -- \
  --server 'wss://<你的服务域名>/runner/v1/connect' \
  --token '<runner-token>'
```

## 构建与暂存

在仓库根目录构建并暂存 Windows x64 产物：

```powershell
cargo build -p nova-runner --locked --release
$env:NOVA_RUNNER_BINARY = (Resolve-Path 'target/release/nova-runner.exe').Path
$env:NOVA_RUNNER_TARGET = 'win32-x64'
pnpm --dir packages/runner stage
pnpm --dir packages/runner typecheck
```

`stage` 从 `NOVA_RUNNER_BINARY` 复制文件到 `vendor/<target>/`。`NOVA_RUNNER_TARGET` 未设置时使用当前平台与架构，非 Windows 目标会设置可执行权限。`typecheck` 仅检查 npm 启动器和打包脚本的 JavaScript 语法，不会编译或验证 Rust 二进制。

`vendor/` 为生成目录，不提交到 Git。发布前必须准备全部四个平台的二进制；`prepack` 会检查四个文件是否存在，但不验证它们的版本和协议兼容性。

## 发布

[`runner-release.yml`](../../.github/workflows/runner-release.yml) 在推送 `runner-v*` 标签时触发，当前没有 `workflow_dispatch` 手动触发入口。先提交要发布的代码，再使用尚未发布过的有效版本号打标签，例如：

```shell
git tag runner-v1.0.0
git push origin runner-v1.0.0
```

流程构建 Linux x64、macOS x64 / arm64 和 Windows x64 的 release 二进制。Linux 构建额外检查 `ldd` 的 libc 依赖、缺失库并运行 `--help`；Windows 安装器使用 Inno Setup 打包。

GitHub Release 包含以下资产：

- `nova-runner-linux-x64.tar.gz`
- `nova-runner-darwin-x64.tar.gz`
- `nova-runner-darwin-arm64.tar.gz`
- `nova-runner-setup.exe`
- `install-runner.sh`
- `SHA256SUMS`

npm 发布使用同一批二进制，暂存全部四个平台后，将 `packages/runner/package.json` 的版本设为标签去掉 `runner-v` 的部分，再执行 `npm publish`。仓库需要配置有 `@nnova/runner` 发布权限的 Actions secret `NPM_TOKEN`。GitHub Release 使用 workflow 自带的 `GITHUB_TOKEN`。

GitHub Release 和 npm 发布是独立作业；npm 发布不等待 Windows 安装包或 GitHub Release 完成，一边失败不代表另一边没有发布。当前流程没有为预发布版本单独指定 npm dist-tag。

[`runner-sdk-release.yml`](../../.github/workflows/runner-sdk-release.yml) 使用 `runner-sdk-v*` 标签，发布的是 `@nova/runner-sdk` 和 `@nova/runner-protocol`，不会发布本包或 Runner 二进制。修改 Runner 默认参数等运行行为后，需要重新发布本包，使用 npm 的设备才能获得更新。
