# tools

> `packages/tools` — Agent 的语义能力层。
> 结构契约见 `repo-layout.md` §4.3。类型定义在 `agent-core.md` §3.2，本文档不重复。

---

## 1. 定位

**负责**：参数 schema 与校验、执行语义、返回结构化的 `AgentToolResult`。

`packages/tools` 是 Tool 的语义包，不是本地执行包。凡涉及文件系统、操作系统、Git 或 Shell 的 Tool，统一走：

```text
packages/tools
  → ToolContext
  → runner-sdk.toToolContext(RunnerSession)
  → Remote Rust Runner
```

生产运行时不存在 LocalTool、LocalFileSystem、LocalShell 或 Node.js fallback。

**不负责**

| 不负责 | 归属 |
|---|---|
| Planning / Task DAG / Retry policy | `agent-core` / `taskflow` |
| Runner 调度 / 权限 | agent-server Runner Module |
| gRPC 连接、消息关联 | `runner-sdk` |
| **输出截断策略** | `agent-core/context/truncate.ts` |
| UI 文案与渲染 | `chat-ui` |

**依赖**：`ToolContext`（`agent-core.md` §3.4）+ `proto` 生成类型。
**不得依赖 `agent-core`** —— 会造成循环依赖（`repo-layout.md` §3.1）。

> 类型 `AgentTool` / `ToolContext` 定义在 agent-core，本包 `import type` 使用。
> 类型依赖不构成运行时循环，但**不得 import 任何 agent-core 的值**。

---

## 2. Tool 类型与落点

| 类型 | 例子 | 落点 |
|---|---|---|
| RunnerTool | `bash` `read_file` `write_file` `edit_file` `grep` `list_dir` `git_diff` | **本包** |
| StateTool | `todo_write` | **本包**；只产出 Agent 状态数据，不访问 FS / OS |
| RemoteTool | `web_search` `github` `jira` | 本包，Phase 3 |
| AgentTool | `spawn_agent` `ask_user` | **`agent-core`**，不在此包 |
| CompositeTool | 多 Tool / Model 组合 | Phase 3 |

`AgentTool` 的流程是 `Tool → Agent Core`，放本包会造成 `tools ⇄ agent-core` 循环依赖，
所以由 agent-core 自行注册（`repo-layout.md` §6.6）。

`StateTool` 不是 LocalTool。它只处理传入参数并返回结构化结果，没有本地文件、进程或网络副作用。Nova 不定义 LocalTool 这一类别。

---

## 3. Phase 1 工具集

字段保持精简。所有路径参数都是**相对 workspace root** 或绝对路径，越界由 Runner 拒绝（`runner.md` §6）。

**`risk` 决定它在哪个模式可用**（`agent-core.md` §1.1）：

| risk | 工具 | Chat 模式 | Project 模式 |
|---|---|---|---|
| `none` | `todo_write` | ✅ | ✅ |
| `read` | `read_file` `read_document` `grep` `list_dir` `git_diff` | ❌ | ✅ |
| `write` | `write_file` `edit_file` | ❌ | ✅ |
| `exec` | `bash` | ❌ | ✅ |

筛选是 composition root 的一行 `tools.filter(t => t.risk === "none")`，
**不在本包里做模式判断**。tool 只声明自己是什么，不知道谁在用它。

### `read_file`

```ts
args:    { path: string; offset?: number; limit?: number }   // 行号，1-based
content: 带行号的文本；截断时标注 "... N lines omitted"
details: { path, totalLines, offset, limit, truncated }
risk:    "read"
```

仅接受 UTF-8 文本。二进制文件（包括 PDF、Office 文档）返回 `BINARY_FILE`，调用方必须改用 `read_document`，不得把原始字节解码后返回给模型。

### `read_document`

```ts
args:    { path: string }
content: PDF / DOCX / XLSX / XLS / CSV 提取出的文本；Excel 以 Sheet 名分段
details: { path, size, truncated }
risk:    "read"
```

通过 `ToolContext.fs.readBytes` 读取受 Runner 路径约束的字节并解析；最大文件大小为 20 MB。

### `write_file`

```ts
args:    { path: string; content: string }
content: "Wrote N lines to {path}"
details: { path, bytes, created: boolean }
risk:    "write"   executionMode: "sequential"
```

### `edit_file`

```ts
args:    { path: string; oldText: string; newText: string; replaceAll?: boolean }
content: 变更处的上下文片段
details: { path, diff: string, replacements: number }
risk:    "write"   executionMode: "sequential"
```

**`oldText` 必须在文件中唯一**（除非 `replaceAll`），不唯一则返回 error 并提示补充上下文。
没有它，agent 每次改一行都要重写整个文件 —— token 成本不可接受。

### `bash`

```ts
args:    { command: string; args?: string[]; cwd?: string; timeoutMs?: number }
content: stdout + stderr（合并，由 agent-core 截断）
details: { exitCode, stdout, stderr, durationMs, truncated }
risk:    "exec"
```

`command` 是可执行文件名或路径，**不会按 shell 命令行解析**；参数必须放在 `args`，例如
`{ command: "ls", args: ["/workspace/synes/"] }`。把整段 `ls /workspace/synes/` 放进
`command` 会被当作一个可执行文件名，并以 `SPAWN_FAILED` 结束。

**非零退出码不是 tool 错误**，照常返回 `status: "ok"`，让模型自己读 exit code 判断。
只有 spawn 失败 / 超时 / Runner 不可用才是 error。

### `grep`

```ts
args:    { pattern: string; path?: string; glob?: string; maxResults?: number }
content: "{file}:{line}: {text}" 列表
details: { matches: Array<{file, line, text}>, total, truncated }
risk:    "read"
```

由 Runner 侧执行（ripgrep 或等价实现），**不拼 shell 命令** —— 拼 shell 会有转义与跨平台问题。

### `list_dir`

```ts
args:    { path: string; depth?: number }     // 缺省 depth 1
content: 树状文本
details: { entries: DirEntry[] }
risk:    "read"
```

### `git_diff`

```ts
args:    { path?: string; staged?: boolean }
content: unified diff
details: { diff: string, files: Array<{path, added, removed}> }
risk:    "read"
```

### `todo_write`

```ts
args:    { items: Array<{ id: string; text: string;
                          status: "pending" | "in_progress" | "completed" | "blocked";
                          note?: string }> }        // note 仅 blocked 用
content: "TODO: {n} 未完成 / {m} 已完成"
details: { items }
risk:    "none"        // 不碰 workspace，Chat 模式也可用
```

**全量覆盖，不是增量 patch。** 模型每次传完整列表，服务端整体替换。
增量语义（add / update / remove）会让模型需要先记住 id 才能改，
而它经常记错 —— 全量覆盖是唯一不会静默错乱的写法。

**这是"规划"能力的全部载体。** 没有 `planning/` 模块（`repo-layout.md` §6.11）：
判定标准在 system prompt 里（`agent-core.md` §9.2），状态就是这份列表，
保活与注入在 `agent-core/context/todo.ts`（§9.4）。

本 tool 只负责**校验并写入**：id 唯一、`blocked` 必须带 `note`、`in_progress` 至多 1 项。
最后一条是刻意的 —— 同时"正在做"三件事的 agent 通常是在瞎跑。

---

## 4. 相对 repo-layout 的调整

### 4.1 删除 `run_tests`

`repo-layout.md` §8 Phase 1 列了 `run_tests`。

**问题**：它的实现就是 `bash("npm test")` 加一层解析。测试命令因项目而异（`npm test` / `cargo test` /
`pytest` / `go test`），要么写死一套猜测逻辑，要么让模型传命令 —— 后者与 `bash` 完全等价。
解析各家测试框架的输出格式则是一个无底洞。

**结论**：删除。验证能力由 `bash` + system prompt 承担 —— prompt 里说明"改完代码要跑测试并读取结果"，
模型自己决定跑什么。这与 `verification/` 降级为 prompt 资产是同一个判断（CLAUDE.md Rule 14）。

### 4.2 新增 `edit_file` 与 `list_dir`

`edit_file` 见 §3，`apply_patch` 在 idea.md §19 已列出，只是没进 Phase 1 清单。
`list_dir` 是 `read_file` 之前的必要一步，缺了模型只能靠 `bash("ls")` 绕。

---

## 5. 实现约定

### 5.1 参数校验

```ts
parameters: JSONSchema      // 同时喂给模型和用于校验
```

**一份 schema 两个用途**，不维护第二份校验代码。校验失败返回 `status: "error"` 的结果喂回模型，
**不 throw** —— 模型传错参数是常态，它自己会改。

### 5.2 一律走 `ToolContext`

```text
✅  ctx.fs.read(path)
❌  fs.readFile(path)                  // Node 直接 IO，绕过 Runner
❌  ctx.exec("cat", { args: [path] })  // 拼 shell 实现文件操作
```

Tool 里出现 `node:fs` / `node:child_process` 的 import 一律视为设计错误。
这是"Runner 是唯一执行平面"的可检验定义。

`ToolContext` 的生产实现只有 `runner-sdk.toToolContext(RunnerSession, ...)`。Tool 本身不得直接依赖 `runner-sdk`，否则 Tool 会认识传输层；由 Host 用 runner-sdk 创建 `ToolContext` 后注入，既保证所有 OS 操作远程执行，也保持 Agent / Tool 与 gRPC 解耦。

允许单元测试注入纯内存 fake 来验证参数和错误分支，但 fake 不能成为产品运行模式，也不能调用测试机的真实 FS / Shell。集成测试必须启动真实 Remote Runner。

### 5.3 `content` 要省 token，`details` 要完整

```ts
// ✅
content: [{ type: "text", text: `Found ${n} matches:\n${top50}` }]
details: { matches: allMatches, total: n }

// ❌ 两边一样
content: [{ type: "text", text: JSON.stringify(allMatches) }]
details: allMatches
```

但**不要在 tool 里做字符数截断** —— 那是 agent-core 的统一策略（`agent-core.md` §8）。
Tool 只做**语义层面的挑选**（取前 50 条、只返回变更行）。

### 5.4 每个 tool 一个文件

```text
packages/tools/src/
├── index.ts          # 导出数组
├── bash.ts
├── read-file.ts
├── write-file.ts
├── edit-file.ts
├── grep.ts
├── list-dir.ts
├── git-diff.ts
└── todo-write.ts
```

没有 `BaseTool` / `ToolRegistry` / `ToolFactory`。
`index.ts` 导出一个数组，调用方自己筛。

---

## 6. Phase 范围

| Phase | 内容 |
|---|---|
| 1 | §3 的 8 个 Tool；其中 7 个 FS / OS / Shell Tool 只通过 Remote Runner 执行，`todo_write` 不访问 OS |
| 3 | RemoteTool（`web_search` / `github`）、CompositeTool |

RemoteTool 推到 Phase 3 的理由：它走 HTTP 而非 `ToolContext`，会引入本包的第一个运行时依赖和
凭据管理问题。核心闭环不需要它。
