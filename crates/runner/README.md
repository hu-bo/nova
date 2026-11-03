# nova-runner

`nova-runner` is a workspace-scoped WebSocket worker for `@nova/runner-sdk`. It keeps operation receipts and active processes in memory for the current boot, continues running after a transport disconnect, and reconciles outstanding operation IDs when it reconnects. It never retries a dispatched operation.

Prebuilt binaries are distributed as [`@nnova/runner`](../../packages/runner/README.md) on npm and through the `runner-release` GitHub workflow. Push a `runner-v<version>` tag to build the four supported platforms, Windows installer, Linux installer, and checksums.

Configure it with command-line options, a TOML file (`--config runner.toml`), or `NOVA_RUNNER_*` environment variables. Command-line options take precedence over TOML values; the workspace must already exist. When no workspace is configured, the Runner uses the directory from which it was started.

```toml
server = "ws://127.0.0.1:4100/runner/v1/connect"
token = "host-issued-token"
workspace = "./work"
workspace_id = "project-42"
runner_id = "device-42"
max_concurrency = 4
read_only = false
```

```powershell
cargo run -p nova-runner -- --config runner.toml
```

The Runner exposes bounded text/binary reads, directory listing, regular-expression search, digest-checked atomic writes/patches, and direct executable invocation with separate arguments. Paths are checked against the registered workspace, including symlink targets. Command output is capped at 10 MiB, file content at 20 MiB (text writes at 1 MiB), active work is limited by a semaphore, and retained result/output receipts are capped at 64 MiB and 1,024 operations. Cancellation and deadlines are checked throughout file traversal and before atomic replacement; command process trees are cleaned up on timeout or cancellation.

Reconnect guarantees are limited to the same Runner process and `boot_id`. A process restart or missing receipt is reported as an unknown outcome; no disk journal, host recovery, or operating-system sandbox is provided.
