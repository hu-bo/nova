# @nova/runner

跨平台发布的 `nova-runner` Rust 可执行文件。该包只负责选择并启动当前平台的
二进制，Runner 的 gRPC、执行、取消和 workspace 行为仍全部实现于
`crates/runner`。

## 使用

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

这个包不是 `@nova/runner-sdk` 的替代品，也不在 Node.js 中执行命令；它只是把已构建
的 Rust binary 作为 npm 可安装物分发。发布包由 CI 在各自平台构建后合并生成。
