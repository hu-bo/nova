# @nnova/runner

跨平台发布的 `nova-runner` Rust 可执行文件。该包只负责选择并启动当前平台的
二进制，Runner 的 gRPC、执行、取消和 workspace 行为仍全部实现于
`crates/runner`。

## 用户安装

Windows 在 GitHub Release 下载 `nova-runner-setup.exe`，双击后填写 server、token 和
workspace。安装器会安装当前平台的 Rust binary，立即隐藏启动，并注册当前
用户登录时自动运行的计划任务。

Linux x64 使用一行命令：

```bash
curl -fsSL https://github.com/hu-bo/nova/releases/latest/download/install-runner.sh | sh -s -- \
  --server "https://agent.example.com/runner-connect" \
  --token "<runner-token>" \
  --workspace "$HOME"
```

脚本验证 GitHub Release 中的 SHA-256，通过 sudo 安装 glibc 2.34+ x64 binary 和
`nova-runner.service`。sudo 只用于安装和管理 systemd；unit 始终以发起安装的
普通用户运行 Runner，并在开机时自动启动。Linux 产物不用静态 musl 构建，避免部分
本地 DNS 对 A / AAAA 的异常响应导致有效 IPv4 地址被判为临时解析失败。

npm 包与 GitHub Release 使用同一个 `x86_64-unknown-linux-gnu` 产物。发布流程在
Rocky Linux 9 中验证动态 libc 依赖并执行 `--help`。已有容器无需修改 DNS 配置，
但需要安装包含新产物的 npm 版本；可用 `getconf GNU_LIBC_VERSION` 检查 glibc 版本。
这项兼容性调整不修复上游 DNS 的 AAAA 错误，连接结果仍需在目标环境验证。

Web UI 默认使用 `https://github.com/hu-bo/nova/releases/latest/download`。部署时可通过
`VITE_RUNNER_RELEASE_URL` 替换 Windows 安装包和 Release 资产的基础地址，通过
`VITE_RUNNER_INSTALL_URL` 单独设置 Linux 脚本地址，例如 `https://get.nova.example/runner`。

## npm / 开发调试

```bash
pnpm add @nnova/runner
npx --yes --package @nnova/runner nova-runner --server http://127.0.0.1:50051 --token <runner-token> --workspace ./project
```

使用上面的 `npx --package` 方式时不需要先执行 `npm install`；npx 会按需获取并缓存
`@nnova/runner`。如果希望固定安装到项目依赖中，也可以执行 `npm install @nnova/runner`，
之后直接运行 `npx nova-runner`。

支持 Linux x64、macOS x64、macOS arm64 和 Windows x64。开发或自定义构建时可用
`NOVA_RUNNER_BIN` 指定二进制路径：

```bash
NOVA_RUNNER_BIN=/path/to/nova-runner npx --yes --package @nnova/runner nova-runner --help
```

Windows PowerShell：

```powershell
$env:NOVA_RUNNER_BIN = 'E:\path\to\nova-runner.exe'
npx --yes --package @nnova/runner nova-runner --help
```

这个包不是 `@nova/runner-sdk` 的替代品，也不在 Node.js 中执行命令；它只分发和安装
已构建的 Rust binary。Inno Setup 和 Linux 脚本也不提供第二套 Execution 实现。
