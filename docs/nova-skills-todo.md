# Nova Skills 实施任务拆解

来源：`docs/nova-skills.md`（下称「设计文档」，§ 编号指向该文章节）。本文把设计拆成可独立执行的长任务清单，按 P0 → P1 → P2 推进；任务粒度以「一次可交付、可验收」为准，允许同一分组内并行。

> **执行状态（2026-11-24 批次）**
>
> - **P0-A 契约（A1/A2/A3）✅**：来源枚举、目录展示字段与不适用原因、Agent profile 引用分支（保留 chat 兼容）、消息/Run 读模型技能引用；typecheck + 包内 node:test 通过（旧 `builtin` 数据兼容、三种技能形态投影、Agent profile 兼容分支）。
> - **P0-B 数据库（B1/B2 ✅，B3 部分）**：`skills`/`skill_versions`/`run_artifacts` 表 + 迁移 `0012`/`0013`（只增表/索引/FK，不改既有表；FK 引用去 `"public".` 前缀与既有约定一致）；服务端 typecheck 通过。真实库迁移实跑被环境阻塞（见文末）。
> - **P0-D Runner（D1–D4 ✅）**：proto 受限资源协议（目录发布/定向刷新/快照读取/受限写入，字段号 17/18）+ 生成物、Rust 扫描器（win32、CAS、逃逸/截断/重名诊断）、发布时机（认证后首个目录、重连重发）、runner-sdk 强类型 API；`cargo test -p nova-runner` 32 通过、SDK 替身测 10 通过。
> - **P0-C Skills 模块（C1/C2/C3/C5 ✅，C4 服务端 ✅）**：解析与校验单来源、平台草稿/版本 API（含发布幂等/冲突/停用/分页/详情）、内置不可变登记（同版本异摘要拒绝）、运行时 ID 适配（`nova.*` 保护、`skill.<uuid>`）；`skill-service`/`skills-parsing`/`skill-runtime-id`/`skill-catalog` 内存替身单测通过。
> - **P0-E 本地接入（E1/E2/E3/E4 ✅）**：目录服务端视图（归属核对、跨 Runner 不串用、失败标过期）、摘要→`0.0.<revision>` 复用映射、快照在发布接受时固定（入队仅读登记版本，事务内不做 RPC）、Agent 解析/接受/`GET /agents`；单测覆盖漂移拒绝、兼容性标注、modelId 校验。
> - **P0-F 入队与快照（F1–F6 ✅）**：单项 `skill` 契约不变、fingerprint 使用 normalized（技能选择参与幂等）、`Checkpoint.execution` 扩展固定（新字段可选兼容旧行）、恢复禁重读磁盘、内置+用户技能合并单个 `skillsPlugin`、预算/模式准入、消息投影带技能摘要；`chat-protocol` 相关既有用例按新行为更新后通过（DB 段除外）。
> - **P0-G（G1 ✅，G2 服务端+Runner ✅，G3 代码闭环 ✅ 端到端待联调）**：`nova.skills-creater` 内置、`skill_write_resource`（effects=write 走模式与审批、写后定向刷新区分「已写入/已发现」）、预期摘要 CAS。
> - **P1（A1/B1/C1/D1/D2/E1/F1 服务端 ✅）**：`artifact.changed` 事件与投影、`run_artifacts` 表、通用对象存储抽象（与图片附件分离）、发布编排与崩溃窗口（重放返回原记录、上传后崩溃按对象核对结算、NotFound 待核实、旧 fence 拒结算）、`GET /conversations/:id/artifacts`/`download`/`preview`（类型矩阵、越权 404）、交付不足结算 failed、清理闭环（会话删除事务内收集对象键→`artifact.purge` Job 幂等删对象 + 定时孤儿扫描按保护期回收）；`artifacts.test` 10 项替身测通过。
> - **未动**：全部 P2。P1-D3 的工作区侧已补齐：Runner 启动初始化统一写 `.gitignore`（`.nova/` 行，幂等、失败仅诊断、符号链接不跟随）；新增 `delete_workspace_paths` RPC（字段号 19，边界/幂等/read_only 门/64 条上限，cargo 44 通过）；`finish()` 在已知终态入队 `run.tmp-cleanup` Job，handler 校验发布全部结算后经 SDK 删除 `.nova/runs/<runId>/tmp`。产物读模型缺口已修：会话快照填充 `snapshot.artifacts`、列表摘要附带 `runState`（来源 Run 结果含历史 Run）、client-config 新增独立 `artifacts` 能力位。
>
> **验证汇总**：`@nova/agent-ui-contracts` typecheck+test 10/10 ✅；`@nova/nova-server` typecheck ✅、lint ✅、`node --test`（串行）151 项 148 通过 0 失败 3 跳过（依赖 `TEST_DATABASE_URL`）；`@nova/nova-client` typecheck+vitest 21 文件 195 全绿 ✅；`@nova/chat-ui` 37/37 ✅；`@nova/tools`/`@nova/runner-sdk`/`@nova/runner-protocol` build/test ✅；`cargo test -p nova-runner` 44 ✅。
> **阻塞**：本机 Docker Desktop 引擎无法启动（dockerd 未运行、WSL Ubuntu-24.04 ext4.vhdx 挂载失败），15000 端口 Postgres 不可达 → B3 迁移实跑、C/E/F 真实库集成、G3/H5/P1-V1 联调待环境恢复后补跑：`$env:TEST_DATABASE_URL=...; pnpm --filter @nova/nova-server exec node --import tsx --test tests/*.test.ts`。

## 0. 使用说明与全局红线

- 每个任务给出：设计依据、依赖、变更落点、要点、验收（DoD）。勾选框即执行清单；完成一条勾一条。
- 开工前按仓库惯例跑 `git status --short`，保留他人改动；只动任务列出的落点。
- 验证命令以各包 `package.json` 为准：服务端单测 `pnpm --filter @nova/nova-server exec node --import tsx --test <文件>`，DB 集成测试用 `TEST_DATABASE_URL`，Runner 用 `cargo test -p nova-runner`，协议生成 `pnpm generate:runner-protocol`，客户端 `pnpm --filter @nova/nova-client typecheck`（会重新生成 API 与路由）。

跨阶段红线（来自设计文档，每个任务验收时复核）：

1. 技能执行配置只能**收紧**宿主能力，不注册新工具、不扩大权限（§1、§4.1）。
2. 服务端校验一切归属（owner、scope、workspace、`canonicalCwd`、版本），不信任客户端与 Runner 上报的用户/项目 ID（§3.1、§4.3、§7）。
3. 不放宽通用文件 RPC 的工作区边界；全局资源走受限资源协议，不作为通用 workspace 注册（§4.3）。
4. 已接受/已入队/运行中的技能版本不可变：恢复禁止重读「最新版本」或当前磁盘文件（§6）。
5. 服务端不执行导入脚本；脚本只在用户绑定的 Runner 机器执行，且不绕过模式与工具策略（§4.2）。
6. 保留既有 `chat` profile、`nova.spec`、`nova.career-coach` 兼容，不另建平行技能执行链路（§2、§4.3）。
7. 代码风格遵守仓库 `AGENTS.md`：禁止新增嵌套三元、状态配置走同一张表、drizzle 类型化操作优先。

## 1. 总览与依赖顺序

```
A 契约扩展 ─┬─ B 数据库 ────┬─ C Skills 模块（平台管理+目录）─┐
            │               └─ E 本地目录接入与快照接受 ──────┼─ F 入队与执行快照 ─ H2/H3 客户端
D Runner 发现与受限协议 ─────────────────────────────────────┘                    │
G skills-creater（依赖 C、D、E）───────────────────────────────────────────────────┘
P1：run_artifacts + artifact_publish + 通用存储 + 卡片/下载（依赖 F）
P2：资源包 + 物化 + requires/探测/脚本审批（依赖 P1 与 D 写能力）
```

- 关键路径：A → B → C/E → F →（P1）→（P2）。D 与 A/B/C 可并行开工，联调点为 E。
- 各阶段收尾必须跑 §10 验收清单（见本文 §5/§6/§7 对应小节）。

---

## 2. P0：可选择并固定版本

### 2.1 A 组 · 共享契约（`packages/agent-ui-contracts`）

#### P0-A1 技能来源与展示契约扩展（§2、§4.1、§8.1）

- 依赖：无
- 落点：`packages/agent-ui-contracts/src/skills.ts`、`messages.ts`（如需）
- 要点：
  - [ ] `productSkillSchema.source` 从 `z.literal("builtin")` 扩为 `z.enum(["builtin","platform","runner-global","runner-project"])`；保持 `id`/`version`（`\d+\.\d+\.\d+`）契约不变，本地技能映射到 `0.0.<revision>` 由服务端完成，契约只承诺格式。
  - [ ] 目录条目补充展示字段：`name`、`description`、来源、适用性状态与「不适用原因」的结构（用于会话选择器与 `/skills` 页面共用，避免客户端手写枚举）。
  - [ ] 运行时 ID 约定注释/类型说明：内置保留 `nova.*`，用户技能为 `skill.<平台UUID>`（§4.1 末段）。
- DoD：`pnpm --filter @nova/agent-ui-contracts typecheck && pnpm --filter @nova/agent-ui-contracts test` 通过；旧 `builtin` 数据仍能 parse。

#### P0-A2 Agent profile 契约扩展（§4.3、§8.1）

- 依赖：无
- 落点：`packages/agent-ui-contracts/src/skills.ts`
- 要点：
  - [ ] `agentProfileSchema` 保留 `{ id: "chat", version }` 兼容分支；新增「有来源和版本的配置引用」分支（供本地/平台 Agent 文件使用，如 `{ source, refId, version }`，命名对齐服务端解析结果）。
  - [ ] 不引入任意 system prompt 字段的通路（§6：Agent 内容由服务端解析，客户端不能传）。
- DoD：typecheck + 包内测试通过；`CHAT_AGENT_PROFILE` 常量与既有聊天行为不变。

#### P0-A3 技能选择进入消息/运行读模型（§3 第 5 条、§6 末段）

- 依赖：P0-A1
- 落点：`packages/agent-ui-contracts/src/messages.ts`、`projection.ts`、`conversation.ts`
- 要点：
  - [ ] 用户消息/Run 摘要增加本次采用的技能引用（id、version、name、source），刷新和历史查看不依赖临时 Composer 状态。
  - [ ] 事件/投影在此定义，服务端只做投影，不在客户端平行手写类型。
- DoD：typecheck 通过；投影用例覆盖「无技能 / 内置技能 / 用户技能」三种输入形态。

### 2.2 B 组 · 数据库（`apps/nova-server/database`）

#### P0-B1 `skills` 表（§8.1）

- 依赖：无
- 落点：`database/schema/skill.table.ts`（新增）、`schema/index.ts`
- 要点：
  - [ ] 字段：UUID、`source`（`builtin|platform|runner-global|runner-project`）、owner、可空 projectId、来源定位（runnerId/workspaceId/相对 cwd/name）、平台草稿正文与元数据、可空 `currentPublishedVersionId`、停用标记、编辑 revision。
  - [ ] 本地来源唯一索引：`(owner, runnerId, scope, workspaceId/cwd, name)`；来源参与稳定资源 ID（§4.3 身份与覆盖）。
  - [ ] 本地行只保存来源索引，不复制一份可独立编辑的草稿（§8.1 事实源列）。
- DoD：drizzle schema 类型化引用；`pnpm --filter @nova/nova-server typecheck` 通过。

#### P0-B2 `skill_versions` 表（§8.1）

- 依赖：P0-B1
- 落点：`database/schema/skill-version.table.ts`、migrations
- 要点：
  - [ ] 字段：UUID、skillId（外键）、语义 version、发布正文、解析元数据、执行配置、内容摘要、可空资源清单（本期不接对象引用）、createdAt；`UNIQUE(skillId, version)`。
  - [ ] 不可变约定写入表注释/服务层约束：发布后不覆盖正文与执行配置；同版本不同摘要拒绝（§6）。
  - [ ] 已发布版本保留策略：无物理删除入口（§8.1 末段）。
- DoD：schema + 迁移生成通过；集成测试（`TEST_DATABASE_URL`）验证唯一约束与外键。

#### P0-B3 迁移与回滚演练（§8.1、§9）

- 依赖：P0-B1、P0-B2
- 落点：`database/migrations/0012_*.sql`（顺延编号）
- 要点：
  - [ ] 用 drizzle 生成迁移，检查生成的 SQL 只做增表/增索引，不改既有表。
  - [ ] 通过 `TEST_DATABASE_URL` 在干净库和既有库各跑一次迁移。
- DoD：迁移 journal/snapshot 更新；服务端既有集成测试全绿。

### 2.3 C 组 · Skills 模块：平台管理与目录合并（`apps/nova-server/src/modules/skills/`）

#### P0-C1 SKILL.md 解析与执行配置校验（§4.1、§8.2 末段）

- 依赖：P0-A1
- 落点：`modules/skills/`（新增 parser/schema 文件）
- 要点：
  - [ ] frontmatter 解析：必需 `name`、`description`；名称小写 kebab-case、≤64 字符；正文写适用任务/方法/输入/结果要求，不强制结构。
  - [ ] 执行配置 schema（P0 范围）：`allowedModes`、`requiredTools`、是否需要工作区、是否要求发布文件；本地可选 `nova` 字段复用同一 schema；省略时应用同一默认值。
  - [ ] 校验规则集中一处（发布 API 与运行准入共用），返回结构化原因，供目录展示「不适用原因」。
  - [ ] 名称与说明只从 frontmatter 派生，不允许表单与正文两份来源（§4.1）。
- DoD：单测覆盖合法/缺字段/非法名称/超长/配置冲突用例。

#### P0-C2 平台草稿与版本管理 API（§8.2）

- 依赖：P0-B1、P0-B2、P0-C1
- 落点：`modules/skills/`（service/repository/routes）
- 要点：
  - [ ] 按 §8.2 表实现：`POST /skills`、`GET /skills/:id`、`PATCH /skills/:id/draft`（携带 `expectedRevision`，防并发覆盖）、`POST /skills/:id/versions`（相同版本同内容返回原版本、内容不同 409）、`GET /skills/:id/versions`（分页）、`GET /skills/:id/versions/:version`、`POST /skills/:id/disable`。
  - [ ] 写入只允许所有者；内置只读；不可见资源按现有约定返回 404；沿用成功/错误信封。
  - [ ] 停用语义：拒绝新选择，保留已接受排队/恢复与历史（§6 末段）。
  - [ ] 版本摘要覆盖规范化正文 + 执行配置 + 资源清单（§4.1）。
- DoD：模块单测 + `TEST_DATABASE_URL` 集成测试覆盖草稿并发、发布幂等、停用后行为。

#### P0-C3 内置技能不可变版本登记（§6 第 4 段）

- 依赖：P0-B2
- 落点：`modules/skills/` + 部署/启动注册流程；`packages/tools/skills/`（spec、career-coach 正文与版本读取）
- 要点：
  - [ ] 内置技能随 `@nova/tools` 发布，部署时按 ID、版本、内容摘要登记（写入 `skills`/`skill_versions`，source=builtin），Run 引用登记行而非代码内联对象。
  - [ ] 同版本不同摘要拒绝覆盖；升级应用后旧正文仍可恢复。
  - [ ] `modules/skills/index.ts` 现有 `builtinSkills`/`resolveSkill` 内存实现改为走登记表，保留 `AcceptedSkill` 对外的形状。
- DoD：集成测试验证「升级后旧 Run 恢复取到旧正文」「同版本冲突被拒」。

#### P0-C4 合并目录查询 `GET /skills`（§3.1、§8.2）

- 依赖：P0-C2、P0-E1（联调）
- 落点：`modules/skills/`
- 要点：
  - [ ] 扩展现有路由：`conversationId`（按原绑定）、`projectId`（按当前绑定）、`runnerId`（纯设备全局层）、`source`、`q`、`cursor`；多参数不一致时服务端裁决并返回明确错误，不信任 URL 组合。
  - [ ] 输出合并内置、平台、Runner 全局、项目来源；带来源、版本、关联项目/Runner、适用模式、可用状态与不适用原因；被同名项目技能遮蔽的全局项仍返回并标注遮蔽（§3.1、§4.3）。
  - [ ] 列表只回摘要；正文走 `GET /skills/:id/versions/:version` 或本地快照按需读取。
  - [ ] 分页/筛选/详情查询键在客户端按账号、项目、Runner、版本隔离（与 H4 对齐）。
- DoD：查询参数组合矩阵单测；跨账号不可见返回 404。

#### P0-C5 运行时 ID 适配层（§4.1 末段）

- 依赖：P0-C1
- 落点：`modules/skills/`（导出给 runs 使用）
- 要点：
  - [ ] 数据库 UUID ↔ 显示名 ↔ Harness 运行时 ID（`skill.<uuid>`；内置保留 `nova.spec` 等确切 ID）转换只在服务端适配处完成。
  - [ ] 内置确切 ID 保护：磁盘同名文件不能替换 `nova.*`（与 D/E 的覆盖逻辑对齐）。
- DoD：转换函数单测（含数字开头 UUID 不加前缀泄露的路径）。

### 2.4 D 组 · Runner 本地发现与受限协议（`crates/runner`、`proto/runner/v1`、`packages/runner-sdk`）

#### P0-D1 proto 定义与代码生成（§4.3 受限协议、§9）

- 依赖：无
- 落点：`proto/runner/v1/`（新增/扩展消息）、`pnpm generate:runner-protocol` 产物
- 要点：
  - [ ] 定义：Runner 能力声明（skills/agents 发现支持位）、目录发布（条目：`kind: skill|agent`、`scope: global|project`、workspace/相对目录标识、名称、说明、入口摘要、目录版本）、定向刷新 RPC、资源快照读取（按资源 ID + 预期摘要 + 包内相对路径）。
  - [ ] 协议不接受任意全局绝对路径；目录只传摘要与必要元数据，不塞全部正文（§2 末段、§4.3）。
  - [ ] 全局资源写能力（供 G2 创建助手安装到 `~/.nova/skills/`）在 proto 一并预留定义，P0 实现可拆到 D6/G2。
- DoD：生成 TS/Rust 无手改；`cargo test -p nova-runner` 协议测试通过。

#### P0-D2 Rust 扫描器（§4.3 扫描根与格式）

- 依赖：P0-D1
- 落点：`crates/runner/src/`（新模块，如 `local_resources.rs`；`main.rs` 初始化接入）
- 要点：
  - [ ] 扫描根：`~/.nova/skills/<name>/SKILL.md`、`~/.nova/agents/<name>.md`、`<projectRoot>/.nova/...`；`~` 为 Runner 进程 OS 用户目录（Windows 对应其目录）。
  - [ ] 项目根默认 Runner 启动目录；显式 `--workspace` 时以规范化注册工作区为有效项目目录；会话 `canonicalCwd` 为子目录时按该目录单独发现项目层，不把整个 workspace 混给所有子项目（`config.rs` 现有规范化逻辑复用）。
  - [ ] 只认源目录直接子项；不递归；不自动搜索 `.agents/`、`.claude/`、祖先目录。
  - [ ] 名称/说明/正文在扫描边界校验（kebab-case ≤64）；包内路径与符号链接解析后不得逃出源根。
  - [ ] 限制：条目数、入口大小、资源清单大小、总耗时；超限标「不完整」并附诊断，不以空结果冒充成功。
  - [ ] 只读：不执行脚本、不创建目录；缺目录视为空；无主目录/权限不足/无效 frontmatter/过大文件/同源重名分别记录诊断且不影响 Runner 连接。
- DoD：`cargo test -p nova-runner` 覆盖上述边界（Windows 路径用例必测——本机即 win32）。

#### P0-D3 同步时机与目录版本（§4.3 时机与诊断）

- 依赖：P0-D2
- 落点：`crates/runner/src/main.rs`（连接建立后）、握手/认证流程
- 要点：
  - [ ] 启动发起全局+默认项目层扫描；认证接入完成后同步首个完整目录，不塞进限时握手。
  - [ ] 重连后重新发布目录版本；响应服务端定向刷新；首次访问新的 `canonicalCwd` 触发定向重扫。
  - [ ] 首版不做文件监听；刷新失败返回错误，由服务端保留旧目录并标过期。
- DoD：Runner 侧集成测试模拟启动/重连/刷新；断连不影响已有会话。

#### P0-D4 runner-sdk TS 封装（§9）

- 依赖：P0-D1
- 落点：`packages/runner-sdk/src/session.ts`、`types.ts`
- 要点：
  - [ ] 暴露目录接收、刷新调用、资源快照读取的强类型 API；错误与「能力不支持」可区分（旧 Runner 未声明发现能力时不伪造空目录）。
  - [ ] 服务端调用侧不改普通文件 RPC 的边界与语义。
- DoD：`pnpm --filter @nova/runner-sdk typecheck` 通过；SDK 单测走替身连接。

### 2.5 E 组 · 服务端本地目录接入与快照接受（`apps/nova-server`）

#### P0-E1 Runner 本地目录服务端视图（§4.3、§8.1）

- 依赖：P0-D1、P0-B1
- 落点：`modules/runs/`（或 `modules/runners/`，按现有 Runner 连接管理归属）、`modules/skills/`
- 要点：
  - [ ] 接收并校验目录：在已认证 Runner session 下核对 owner、scope、workspace、`canonicalCwd`；不信任上报的用户/项目 ID。
  - [ ] 目录版本、诊断、能力位存认证 session（内存/连接态即可，§8.1：首期 Agent 目录不进独立管理表）。
  - [ ] 来源身份 → 稳定资源 ID：两个 Runner 的同名全局技能不是同一资源。
  - [ ] `POST /runners/:id/resources/refresh`：校验归属及 workspace/cwd 后定向刷新，返回目录版本与诊断。
- DoD：集成测试覆盖归属伪造被拒、跨 Runner 不串用、刷新失败保留旧目录标过期。

#### P0-E2 本地内容摘要 → 版本映射（§4.3 末段）

- 依赖：P0-E1、P0-B2
- 落点：`modules/skills/`
- 要点：
  - [ ] 无语义版本号的本地文件按来源身份 + 内容摘要映射服务端递增 `0.0.<revision>`；同摘要复用版本行。
  - [ ] PostgreSQL 保存执行版本与来源索引；磁盘文件保持唯一可编辑源；MinIO 不参与 P0。
  - [ ] 编辑磁盘文件不热替换已接受版本（下次刷新形成新快照，新选择需重新核实）。
- DoD：单测覆盖摘要复用、版本递增、目录更新不影响已入队引用。

#### P0-E3 入队前内容快照获取流程（§4.3、§6）

- 依赖：P0-E2、P0-D1
- 落点：`modules/skills/` + `modules/conversations/` 提交路径
- 要点：
  - [ ] 事务外：通过受限资源协议按匹配目录摘要取内容快照；原文件已变化则返回「需刷新后重新选择」，不以新内容替代旧摘要。
  - [ ] 事务内：现有 Service 事务中校验归属、幂等并固定快照引用。
  - [ ] 认证前不向服务端发送资源正文（连接建立时序验证）。
- DoD：并发编辑窗口用例（取快照 vs 文件变化）；失败路径不产生半固定状态。

#### P0-E4 Agent 配置接入（§4.3 Agent 配置、§8.2 `GET /agents`）

- 依赖：P0-D2、P0-E1
- 落点：`modules/skills/`（或独立 agents 适配，沿用 skills 模块公开 `index.ts` 出边界）+ `GET /agents?conversationId=...&projectId=...`
- 要点：
  - [ ] 解析 `~/.nova/agents/*.md`、`.nova/agents/*.md`：名称取文件名、`description` 必填、正文为角色提示；可选 `modelId`（必须在用户已有模型配置中可用）、工具限制（只缩小宿主能力）、技能名称引用（按同一项目目录顺序解析）。
  - [ ] 首期作为可选主 Agent profile，独立于技能选择展示；Agent 的技能引用只是界面预选建议，发送仍显式提交至多一个用户技能。
  - [ ] 导入含 `mode: subagent/all` 等未支持字段时报告不兼容，不静默加载；Agent 不能覆盖模式、审批或平台基础指令。
  - [ ] 已选择的 Agent 内容与解析后的技能引用一起固定到执行快照（衔接 P0-F2）。
- DoD：`GET /agents` 兼容性与归属校验测试；含 OpenCode 风格文件的导入不兼容用例。

### 2.6 F 组 · 入队、执行快照与运行时装配（`modules/conversations`、`modules/runs`）

#### P0-F1 输入契约与入队校验（§6 第 1-2 段、§8.2）

- 依赖：P0-A1、P0-C1、P0-C5、（本地场景）P0-E3
- 落点：`modules/conversations/conversation.schema.ts`、`conversation.service.ts`、`conversation.repository.ts`；`modules/runs/agent-profile.ts`
- 要点：
  - [ ] 沿用单项 `skill?: { id, version }`，与本次 `SubmitInput` 绑定；不新增 `skills[]`，不放进持续继承的 Configuration；省略 = 本次无用户技能。
  - [ ] 入队前 Skills 模块校验：所有权、项目范围、版本可用性、模式与所需工具；本地目录项先映射确切版本再提交引用。
  - [ ] 规范化后的技能选择参与请求 fingerprint（`conversation.repository.ts` 现有 `fingerprint(input)` 路径）：同幂等键更换技能返回冲突。
  - [ ] 精确版本引用写入 `pending_inputs` 的服务端元数据；排队后技能更新不替换引用。
  - [ ] 校验失败在入队前返回明确原因（版本不存在/不可选/模式不符）。
- DoD：`chat-protocol.integration.test.ts` 扩展：提交→排队→领用链路带技能引用；幂等冲突用例。

#### P0-F2 执行快照扩展与恢复（§6 第 3 段）

- 依赖：P0-F1
- 落点：`modules/runs/agent-profile.ts`（`AcceptedExecution`）、`session-checkpoint.ts`、`nova-runtime.ts`、`conversation-executor.ts`
- 要点：
  - [ ] 扩展现有 `Checkpoint.execution` / `AcceptedExecution`：来源、技能版本 ID、运行时 ID、版本号、内容摘要、已接受 Agent 内容；不新增 `skillExecution` 平行字段。
  - [ ] 恢复固定用同一版本与 Agent 内容，禁止重读最新或磁盘；审批挂起与恢复使用同一选择。
  - [ ] 新普通输入重新计算技能选择，不从上一 checkpoint 意外保留已取消的技能。
- DoD：checkpoint 序列化兼容旧行；恢复用例断言正文与版本一致。

#### P0-F3 skillsPlugin 装配（§6 第 5 段、§2）

- 依赖：P0-C3、P0-C5、P0-F2
- 落点：`modules/runs/nova-runtime.ts`；`packages/harness/src/plugins/skills/index.ts`（只读参照，尽量不改）
- 要点：
  - [ ] 执行前把固定版本转 `SkillResource[]`，内置 + 用户技能合并进**同一个** `skillsPlugin`（`packages/tools/src/spec-skill.ts` 安装方式沿用），避免重复插件 ID。
  - [ ] 保留 40,000 字符总预算：选择与准入阶段返回超限原因，不静默截断。
  - [ ] 不改通用 Harness 领域边界；`skill_read_resource` 属 P2，本期不装。
- DoD：预算超限返回结构化错误；Spec 场景 `nova.spec` + 用户技能共存注入用例。

#### P0-F4 Goal / steer / Spec 语义（§3 第 4 段）

- 依赖：P0-F2
- 落点：`modules/runs/`（goal 自动迭代路径）、`modules/specs/`（回归即可，不预期改动）
- 要点：
  - [ ] Goal 自动迭代沿用触发时固定的技能版本；steer 只补充方向，活动 Run 内更换技能拒绝，下一次普通输入生效。
  - [ ] Spec 专用会话仍由服务端选 `nova.spec`；用户技能不授予确认、验收、任务绑定能力。
- DoD：goal 触发带技能与不带技能的迭代用例；Spec 回归绿。

#### P0-F5 模式准入双端校验（§3 第 4 条）

- 依赖：P0-C1、P0-F1
- 落点：`modules/conversations` 校验 + 客户端提示（H1 协同）
- 要点：
  - [ ] 选择技能不切换执行模式；要求写文件/执行命令的技能在 Plan 下入队即拒（服务端），UI 提示使用 Build/Auto；继续遵守所选模式授权。
  - [ ] 「是否需要工作区」「是否要求发布文件」的 P0 判定进入目录适用性与入队校验（存储未配置的提示衔接 P1，在 P0 用能力位预占字段）。
- DoD：Plan + 写要求技能 → 400 明确原因；Build/Auto 正常。

#### P0-F6 执行摘要进入消息（§3 第 5 条）

- 依赖：P0-A3、P0-F2
- 落点：`modules/runs/tool-blocks.ts`/消息投影、`agent-ui-contracts` 投影实现
- 要点：
  - [ ] 消息记录显示本次技能与版本（含内置）；投影与事件在 `@nova/agent-ui-contracts` 定义，服务端投影实现。
- DoD：SSE 断线重连后历史消息仍显示技能摘要。

### 2.7 G 组 · 内置技能创建助手（§4.4）

#### P0-G1 `nova.skills-creater` 内置技能（§4.4、§9）

- 依赖：P0-C3、P0-C1
- 落点：`packages/tools/skills/skills-creater/SKILL.md`（新增）、`packages/tools/src/`（导出）、`modules/skills`（并入目录）
- 要点：
  - [ ] 运行时 ID `nova.skills-creater`，展示名「技能创建助手」；经 `@nova/tools/harness` 导出，与 `nova.spec` 合并进单个 `skillsPlugin`，不另建执行循环，不装到 Codex 开发技能目录。
  - [ ] 正文覆盖：触发范围（创建/改写/整理 Nova 技能）、流程（理解任务与输入输出 → 检查目标目录与相近技能 → 确定名称/触发说明/最小方法）、产物要求（有效 name/description、使用场景、输入步骤、真实输出位置、失败处理、验证方法、至少一正一反触发检查）、禁止项（不生成空目录、不依赖尚不存在的工具、不覆盖内置版本、不自动发布平台、不自动改 Agent 配置；脚本声明遵守 §4.2 即本期不产出可执行脚本承诺）。
  - [ ] 默认项目级 `<projectRoot>/.nova/skills/<name>/SKILL.md`；全局安装仅按用户明确要求。
- DoD：目录接口能选到该技能；正文评审通过（内容走查即可）。

#### P0-G2 受限本地资源写入（§4.4 第 4 段，衔接 D1）

- 依赖：P0-D1
- 落点：`proto/runner/v1/`、`crates/runner/src/`、`packages/runner-sdk/`、`modules/runs/` 工具接线
- 要点：
  - [ ] Runner 侧从 `scope` + 合法技能名 + 包内相对路径 + 预期摘要解析目标，只允许写已知技能源根；不提供任意 home 文件写入；不提供任意绝对路径接口。
  - [ ] 按实际写副作用授权（走现有模式与审批），不复用只读发现权限。
  - [ ] 更新先读现有内容并以预期摘要防止覆盖并发编辑；不默认覆盖同名技能。
- DoD：`cargo test -p nova-runner` 路径逃逸/非法名/摘要不符用例；审批链路复用现有 bash 之外新增工具的策略核对。

#### P0-G3 创建助手落盘闭环（§4.4 第 5-6 段）

- 依赖：P0-G1、P0-G2、P0-D3、P0-E1
- 落点：`modules/skills/`（刷新联动）、客户端预选（H4）
- 要点：
  - [ ] 写入后读取实际文件、校验 frontmatter/名称/引用路径，再触发对应目录定向刷新，返回新目录版本与技能引用。
  - [ ] 刷新失败如实区分「文件已写入」与「已被目录发现」。
  - [ ] 「创建技能」入口预选 `nova.skills-creater` 并沿用当前环境。
- DoD：端到端手工验证：项目安装 / 全局安装 / Plan 只起草 / 并发摘要保护 四种路径。

### 2.8 H 组 · 客户端与 chat-ui

#### P0-H1 Composer 技能选择交互（§3 第 1-4 条、§3 末段）

- 依赖：P0-A1、P0-C4、P0-F1
- 落点：`apps/nova-client/src/features/conversations/use-conversation-composer.ts`、相关组件；`packages/chat-ui/`
- 要点：
  - [x] 保留 `/` 宿主命令与现有快捷命令；新增「选择技能」入口，命令与技能分类型分回调；Agent 选择独立展示，不与技能标签、`/plan`、`/build` 混类。
  - [x] 技能列表显示名称、用途、来源、是否适用当前环境与不适用原因；选中后输入框显示可移除技能标签；发送携带精确版本。
  - [x] 每条输入显式选择至多一个用户技能：不从上条/缓存静默继承；输入框可保留本地选择便于连发，但每条请求明确提交并展示；清除上下文清本地选择。
  - [x] 无工作区时仅分析类技能可选；需工作区的技能标注「需要绑定工作区」；存储未配置标注「文件产出暂不可用」（能力位读取，P1 前恒真提示可后置）。
  - [x] Plan + 需写/执行技能 → 界面提示切 Build/Auto（服务端仍二次校验）。
- DoD：`conversation-composer.test.tsx` 扩展；注意该文件当前有未提交改动，动手前先 `git status` 核对，保留之。

#### P0-H2 chat-ui 展示层扩展（§9）

- 依赖：P0-H1
- 落点：`packages/chat-ui/`
- 要点：
  - [x] 技能菜单、标签、Agent 选择、技能摘要展示仅 props/callback；网络与持久化留在宿主。
  - [x] 消息行展示本次技能与版本（消费 P0-A3 摘要）。
- DoD：`pnpm --filter @nova/chat-ui test`（vitest）；`chat-ui.test.tsx` 现另有未提交改动，同样先核对再改。

#### P0-H3 `/skills` 路由与侧栏入口（§3 第 6 条、§3.1）

- 依赖：P0-C4
- 落点：`apps/nova-client/src/routes/skills/index.tsx`（新增）、`app/sidebar/`、WorkspaceShell 注册；路由树由现有文件路由生成流程更新
- 要点：
  - [x] 与会话/项目页面同级，沿用 RequireIdentity 登录边界；路由文件只做入口与 search 参数校验，业务在 `features/skills/`。
  - [x] 侧栏「我的技能」导航。
- DoD：直达 `/skills` 刷新可恢复；未登录跳登录与其他页面一致。

#### P0-H4 features/skills 列表、详情与筛选（§3.1）

- 依赖：P0-H3、P0-E1
- 落点：`apps/nova-client/src/features/skills/`（新增）
- 要点：
  - [x] 默认展示当前用户平台技能 + 可用内置；选 Runner 显示其全局技能；选项目按当前绑定 Runner 与 `canonicalCwd` 显示项目+全局技能。
  - [x] 筛选进 URL：`/skills`、`/skills?runnerId=`、`/skills?projectId=`；`projectId` 存在时由项目绑定决定 Runner，切换项目清理不匹配设备筛选；详情用可选 `skillId/version` search 参数支持刷新直达。
  - [x] 查询键隔离账号/项目/Runner/版本；分页与筛选走服务端。
  - [x] 列表项：名称、说明、来源、版本、关联项目/Runner、适用模式、可用状态；遮蔽项可见来源。
  - [x] 详情面板：`SKILL.md` 正文（按需加载，本地走资源快照且校验匹配摘要）、执行要求、资源清单（P2 前显示为空）、目录诊断；任意文件路径不可读。
  - [x] 「刷新本地技能」仅在已选择且支持发现能力的 Runner 可用；失败保留已显示结果并标过期；过期/不完整目录中的新选择须重新核实。
  - [x] 「在会话中使用」把确切技能引用 + 所选环境带入新会话输入框，发送后才执行。
- DoD：feature 测试覆盖 URL 恢复、遮蔽显示、离线/扫描中/空目录/失败四类状态提示不混同。

#### P0-H5 状态与空态提示矩阵（§3.1 第 3、8 段）

- 依赖：P0-H4
- 要点：
  - [x] 项目未绑定、Runner 离线、扫描未完成、目录为空、筛选无结果、接口失败分别有独立文案与可操作性；不得当作「用户没有技能」。
  - [x] 旧 Runner 无发现能力：UI 说明本地发现不可用，可继续用内置/平台技能。
- DoD：走查截图或测试快照。

### 2.9 I 组 · P0 收尾验证

#### P0-I1 测试扩展与回归（§10）

- 依赖：前述全部
- 要点：
  - [ ] 扩展 `apps/nova-server/tests/chat-protocol.integration.test.ts`：带技能排队、恢复、幂等冲突。
  - [ ] 扩展 `specs.integration.test.ts`：Spec 会话 + 用户技能互不越权。
  - [ ] Harness 技能版本校验与预算边界按需补测（不假设已有专门用例）。
  - [ ] `pnpm --filter @nova/nova-server typecheck`、`pnpm --filter @nova/nova-client typecheck`（重新生成 OpenAPI 与路由）、`pnpm --filter @nova/agent-ui-contracts typecheck`、`cargo test -p nova-runner`、相关包测试全绿。
  - [ ] 收尾 `git diff --check`。

#### P0-I2 P0 验收清单（设计文档 §10 P0 行 + §426-432 逐条）

- [ ] 本地发现有界且不执行脚本；项目覆盖全局、内置确切 ID 不被替换。
- [ ] 正文固定后编辑磁盘文件不影响恢复；创建助手能按模式起草或安装。
- [ ] 既有 chat / Spec 兼容：`nova.career-coach`、`nova.spec` 继续工作。
- [ ] `/skills` 侧栏直达；筛选/详情刷新恢复；跨账号/项目/Runner 查询不串用；查看/预览/预选不自动执行。
- [ ] 正文按需加载；来源、版本、遮蔽、环境状态可识别；各类空态/失败态提示区分。
- [ ] 默认启动目录与显式 `--workspace` 均按约定扫描；`canonicalCwd` 子项目隔离；全局目录属 Runner 用户，Worker 主目录不参与发现。
- [ ] 缺目录、不可读、错误 frontmatter、同源重名、截断、越界链接均有明确结果；认证前不发正文。
- [ ] 断线/刷新失败/能力不支持时 UI 状态正确；已接受版本不被热替换。
- [ ] `skills-creater` 默认项目技能；Plan 或无工具聊天只起草；预期摘要保护；刷新失败不假报已安装。
- [ ] 本地 Agent 可选择且按版本固定；不能授予宿主未提供的工具；子 Agent 模式显示不兼容。

---

## 3. P1：文件产物闭环

### P1-A1 产物契约与事件（§7、§8.2 末段、§9）

- 依赖：P0-A1、P0-A3
- 落点：`packages/agent-ui-contracts/src/events.ts`、`messages.ts`、`projection.ts`
- 要点：
  - [ ] `artifact.changed` 事件仅带 `{ artifactId, runId, state }`；索引变化与事件同事务提交（服务端保证，契约定义形状）。
  - [ ] 产物摘要进入会话读模型（文件名、大小、来源 Run、state、可否预览、下载入口），配合 `GET /conversations/:id/artifacts` 供断线重刷。
  - [ ] 复用现有 `file/image` Block 与 `object/runner/ssh` 引用形状时注意：图片签名接口只认附件对象键，产物走独立接口，不套用（§2 文件展示契约行）。
- DoD：typecheck；投影用例覆盖 publishing/ready/failed 三态。

### P1-B1 `run_artifacts` 表与迁移（§8.1）

- 依赖：P0-B3
- 落点：`database/schema/run-artifact.table.ts`、migrations
- 要点：
  - [ ] 字段：UUID、runId（外键）、toolExecutionId、可空 skillVersionId（外键）、name、mimeType、size、sha256、objectKey、state（`publishing|ready|failed`）、恢复元数据、错误、时间；`UNIQUE(runId, toolExecutionId)`。
  - [ ] 归属由 Run → 会话链派生，不另建权限关系表；首版最多一个用户技能，产物归属本次用户技能，仅内置/普通会话按实际来源记录或留空（§8.1 末段）。
  - [ ] 状态只描述文件发布，执行结果仍读 `runs.state`，不维护第二套状态机（§7）。
- DoD：约束测试（重放返回原记录、唯一冲突）。

### P1-C1 通用文件存储接口（§2 私有对象存储行、§7 第 4 步）

- 依赖：P1-B1
- 落点：`apps/nova-server/src/modules/artifacts/`（新增模块）；参照 `modules/attachments/upload-storage.ts`
- 要点：
  - [ ] 复用现有私有 bucket，新增 `artifacts/...` 与（P2 预留）`skill-bundles/...` 前缀；所有 ID 与对象键服务端构造，显示文件名只存数据库不参与拼键（§5.2）。
  - [ ] 新增通用上传/查询存在性/删除接口；不调用图片专用 `completeUpload`；签名 URL 短期化，不持久化（§5.2、§7）。
  - [ ] 存储替身测试模式参照 `attachments.test.ts`。
- DoD：单测覆盖对象键构造、20 MiB 边界、类型白名单挂点。

### P1-D1 `artifact_publish` 宿主工具（§7、§6 时序图）

- 依赖：P1-C1、P0-F2
- 落点：`packages/tools/src/tools.ts`（工具定义）、`modules/runs/runner-tool-context.ts`、`conversation-executor.ts`/`nova-runtime.ts`（Worker 接线）
- 要点：
  - [ ] 入参仅 `{ path, name? }`，path 相对 `outputDir`；owner/会话/绑定环境/目录由服务端从当前 Run 派生，不接受模型给标识、对象键、URL。
  - [ ] `effects: "write"`，走现有模式与审批；**Plan 不安装该工具**；需要 Plan 展示结构化结果时走消息或既有 Spec 候选流程。
  - [ ] 返回产物 ID、实际大小、摘要；最终回复引用产物 ID，服务端不解析模型给的本机路径创建下载项。
- DoD：工具策略用例（Plan 不可见/Build 审批/Auto 直通）。

### P1-D2 发布流程与崩溃窗口（§7 步骤 1-6 + 窗口表）

- 依赖：P1-D1、P1-B1
- 落点：`modules/artifacts/`（service）
- 要点：
  - [ ] 稳定发布键：`(runId, toolExecutionId)` 唯一记录 + 额度预留；重放返回原记录。
  - [ ] 路径校验：真实文件必须位于本 Run 的 `outputs/` 内，拒绝目录、越界、符号链接逃逸（比现有项目级约束更窄）。
  - [ ] `fs.readBytes` 读字节 → 服务端算大小与 SHA-256 → 校验允许的文件类型 → 冻结字节与摘要后上传；源文件变化且旧对象未找到返回冲突，不把新内容当旧发布成功。
  - [ ] 先持久化摘要/大小/对象键，再事务外上传不可变键；上传确认后同一事务校验有效 Worker fence → 标 `ready` → 释放预留 → 提交 `artifact.changed`；网络上传期间不持事务；旧 fence 不能提交。
  - [ ] 恢复矩阵逐条实现并有用例：对象已传/结算前退出→按发布键核对完成结算；上传超时结果未知→查原对象校验、保留待核实、不重新生成；NotFound 且旧上传未确认停止→保留待核实；失败已知→记原因、释放额度、文件留工作区、允许一次明确的新发布；发布成功后 Run 失败/取消→保留产物且卡片展示来源 Run 结果；技能声明必须交付但无 ready 产物→结算交付失败。
  - [ ] 额度：单文件 20 MiB（Runner 首版）、文件数、Run 总量、账户配额发布前校验并为并发上传预留（§5.3）。
- DoD：`modules/artifacts` 协议与崩溃窗口用例（含注入退出/超时）；`TEST_DATABASE_URL` 集成。

### P1-D3 outputDir 与工作区目录约定（§5.2）

- 依赖：P0-F3
- 落点：`modules/runs/nova-runtime.ts`（上下文注入）、工作区初始化流程、`packages/tools/skills/spec|career-coach` 文档不动
- 要点：
  - [ ] 每个 Run 注入相对 `canonicalCwd` 的 `.nova/runs/<runId>/outputs|tmp`；同一 Run 恢复复用；代码任务仍在原路径改。
  - [ ] `.gitignore` 排除 `.nova/` 在工作区初始化流程统一处理，技能不自行改 `.gitignore`；不假设仓库根 `output/` 适用。
- DoD：恢复复用目录用例；初始化后 `.gitignore` 效果验证。

### P1-E1 下载、预览、列表 API（§7 下载段、§8.2）

- 依赖：P1-D2
- 落点：`modules/artifacts/`（routes）
- 要点：
  - [ ] `GET /conversations/:id/artifacts?cursor=`、`GET /artifacts/:id/download`（先验 产物→Run→会话→当前用户/项目 再签短期 URL）、`GET /artifacts/:id/preview`（Markdown/纯文本受限内容 + 允许图片短期 URL；HTML/SVG 强制下载；不接受任意 object key 换签）。
  - [ ] Office/PDF 首版仅下载；产物再入模型输入是独立能力，本期不做。
- DoD：越权 404、URL 过期、预览类型矩阵测试。

### P1-F1 清理 Job（§7 末段）

- 依赖：P1-D2、现有 `job.table.ts` 机制
- 落点：`modules/artifacts/` + worker 定时任务
- 要点：
  - [ ] 临时目录在 Run 已知终态且发布全部结算后按策略清理；不清理待核实操作的源文件。
  - [ ] 删除会话时在既有删 Run 事务中级联清索引 + 写对象删除 Job，事务外删对象；项目删除沿会话清理；停用技能不删历史产物。
  - [ ] Job 重试 + 定期孤儿对象扫描兜底，保护 publishing 记录与有效预留；TTL/配额留在配置。
- DoD：删除会话→对象最终消失；孤儿扫描不误删在途产物。

### P1-G1 客户端产物卡片与入口（§3 第 5 条、§9）

- 依赖：P1-A1、P1-E1
- 落点：`apps/nova-client/src/features/artifacts/`（新增）、`packages/chat-ui/`
- 要点：
  - [ ] 卡片：文件名、大小、来源 Run、下载入口、Run 结果；文本/图片预览；HTML/SVG 显示为下载。
  - [ ] 消费 `artifact.changed` SSE 刷新对应查询；断线后用列表接口兜底。
  - [ ] 「文件产出暂不可用」（MinIO 未配置）与 SSH 环境不支持发布的选择期提示落地（衔接 P0-H1 预留的能力位）。
- DoD：feature 测试 + 手工走查。

### P1-V1 P1 验收（§10 P1 行）

- [ ] Markdown/CSV 生成后刷新可下载；同名不同 Run 不覆盖。
- [ ] 20 MiB 超限明确失败；路径与符号链接逃逸被拒。
- [ ] 上传后崩溃恢复不重复产物；旧 fence 无法提交。
- [ ] 无存储 / SSH 能力不足在准入提前提示，不假装可下载。
- [ ] 真实端到端：绑定 Runner 工作区，含断线、取消、上传状态未知场景。

---

## 4. P2：资源包与丰富格式

### P2-A1 资源包导入与存储（§4.2）

- 依赖：P1-C1
- 要点：
  - [ ] 目录布局 `SKILL.md + references/ + assets/ + scripts/`；上传包校验相对路径、文件数、解压大小、软链接、逐文件摘要；存不可变对象键 `skill-bundles/<owner>/<skillId>/<version>/<bundleSha256>/<resourcePath>`。
  - [ ] `skill_versions` 挂对象引用与资源清单（只记路径/大小/摘要，不复制正文事实）；原始压缩包如保留仅用于审计/下载，不是运行时读取源。
  - [ ] 平台发布与本地快照同时固定资源清单与真实字节（衔接 P0-E3 预留）。
- DoD：恶意包夹具（路径穿越、软链、超量解压）全部拒绝。

### P2-A2 `skill_read_resource` 工具（§4.2 第 2 段）

- 依赖：P2-A1、P0-F3
- 要点：
  - [ ] 只读本次 Run 已绑定版本的资源；不把整包灌入上下文；按需加载。
- DoD：越界（未绑定版本/包外路径）拒绝用例。

### P2-B1 资源物化与二进制同步（§4.2 第 3-5 段）

- 依赖：P2-A1、D 组写能力
- 要点：
  - [ ] Runner 写文件 API 扩展二进制与更大体积（现文本 1 MiB 上限），不截断后继续执行。
  - [ ] 按摘要缓存到 `.nova/cache/skills/<skillId>/<version>/<bundleSha256>/`；扫描器不扫缓存；全局源经受限资源协议读取后物化。
  - [ ] 宿主协调同一缓存键并发物化；逐文件校验长度 + SHA-256，全匹配才标可用；部分缓存不可执行；缓存命中也验入口与包内依赖，缺失/损坏重建（不以路径含摘要代替校验）。
  - [ ] 不承诺进程沙箱：文档与 UI 说明 Runner 直接启动程序具有 OS 账户权限。
- DoD：损坏缓存触发重建用例；并发物化不互踩。

### P2-C1 `requires` 声明与发布校验（§4.2 脚本执行契约）

- 依赖：P0-C1
- 要点：
  - [ ] `requires.targets` 按平台选择唯一目标配置，平台值与 `identity.platform`（linux/macos/windows）对齐；发布校验平台集合不重叠、声明完整、版本约束可解析；未列入平台不适用。
  - [ ] 含可执行脚本的版本必须声明 `requires`；纯 Markdown 可省略；不做 P0/P1 式依赖探测。
- DoD：发布校验单测；CRLF shell 脚本发布前拒绝或确认前统一 LF。

### P2-C2 目标 Runner 环境探测（§4.2 环境声明与准入）

- 依赖：P2-C1、D 组
- 要点：
  - [ ] 在目标 Runner（不是 Worker 本机）用宿主固定探测方式检查解释器存在、解析路径、实际版本；不把 `capabilities:[exec]` 当已安装；项目依赖在脚本产生业务副作用前检查。
  - [ ] 适用性三态：满足/不满足/待验证；未探测、离线、被拒、超时 ≠ 满足，也不谎报未安装。
  - [ ] 入队做静态检查；Build/Auto Run 在脚本执行前经已授权命令通道探测；Plan 不为探测开放命令；不满足/待验证不派发脚本。
  - [ ] 探测记录环境标识与时间；重连、进程重启、绑定变更、依赖变化后复查；缓存只辅助展示。
  - [ ] 不因选择技能自动安装软件或提权；缺依赖报告具体原因。
- DoD：三态 × 通道矩阵测试。

### P2-C3 脚本启动与调用规范（§4.2 启动方式与编写要求）

- 依赖：P2-B1、P2-C2
- 要点：
  - [ ] 显式解释器启动：`node <script>`、`python3 <script>`、`sh <script>`、PowerShell 用已探测程序 + `-NoProfile -File`；不依赖 shebang/文件关联/可执行位/`chmod +x`。
  - [ ] `command` 只放程序名或已验证路径，参数逐项进 `args`；不拼整条命令行；不依赖隐式管道/重定向/变量展开。
  - [ ] 宿主注入缓存目录、工作目录、`outputDir`，脚本经参数取得，不硬编码绝对路径。
  - [ ] 执行记录关联固定版本、包摘要、入口摘要、解释器实际路径/版本、参数、cwd、超时、目标环境。
- DoD：Windows/Linux/macOS Runner 显式启动各一例；无执行位脚本可运行。

### P2-C4 审批与共享边界强化（§4.2 审批与共享边界）

- 依赖：P2-C3
- 要点：
  - [ ] 脚本调用审批关联服务端从固定版本生成的包/入口信息；审批展示目标 Runner/工作区、解释器、参数、入口、包/入口摘要，可查已发布脚本内容。
  - [ ] 包级授权如会话内复用须绑定摘要与目标环境；内容或环境变化重新授权；现有 `checkpoint.approvals` 按工具名复用 `bash` 的授权不得标记为「已审阅技能包」。
  - [ ] 组织共享/市场开放前：Runner 侧「核验并启动固定内容快照」原子能力（必要时更新 `proto/runner/v1/`）+ 绑定快照的审批策略；未实现则脚本保持所有者自用。
- DoD：审批 UI 内容核对；「普通 bash 授权 ≠ 包级认可」用例。

### P2-C5 重连、换机与恢复（§4.2 重连段）

- 依赖：P2-C4
- 要点：
  - [ ] 旧会话固定 binding revision，换绑不自动迁移；显式迁移/新绑定/同 Runner 重启后重匹配平台、重探测、验证缓存，必要时重物化。
  - [ ] 缓存与探测记录至少区分 `runnerId`、`bootId`、`workspaceId`、binding revision；不按技能版本假设他机已装。
  - [ ] 资源重建 ≠ 命令重放：结果未知先用原 Runner 操作 ID 与执行记录核实，未确认不在新机重跑；恢复沿用 Run 原截止时间（创建后 30 分钟），不因重物化/重连重置。
  - [ ] 超时/取消后核实原进程结果；不把残留文件当测试通过；断线未知结果不自动重试整个脚本；退出码非零如实记录；文件产出与整体成功分开判断。
- DoD：换机/重启/未知结果场景集成测试。

### P2-D1 SSH 真实二进制读取（§2 SSH 工作区行、§5.3）

- 依赖：P1-D2
- 要点：
  - [ ] SFTP 二进制读取 + 项目目录内路径校验 + 大小限制，替换 `ssh-tool-context.ts` 当前 `Buffer.from(readText(...).text)`（底层 256 KiB 文本上限不适用于产物）；完成后对 SSH 工作区开放发布。
- DoD：PDF/Office 字节一致性摘要比对测试。

### P2-E1 页面与格式扩展

- 依赖：P2-A1、P1-G1
- 要点：
  - [ ] `/skills` 详情显示真实资源清单与包诊断；按需引入 Office/PDF 隔离预览；隔离预览如涉 iframe/沙箱，按前端交互设计单独评估。
- DoD：清单与摘要一致性走查。

### P2-V1 P2 验收（§10 P2 行 + §434-440 逐条）

- [ ] 包路径/解压限制生效；停用不破坏历史恢复。
- [ ] 环境验证与脚本审批生效；PDF/Office 摘要与字节一致；不支持的环境可解释。
- [ ] 声明支持平台上显式解释器启动；缺解释器/版本不符/依赖缺失/拒绝探测均有明确结果；待验证不显示为可执行。
- [ ] 无执行位脚本可跑；CRLF 发布前检查；物化文件与最终发布摘要一致；缓存损坏阻止启动并触发重建。
- [ ] 换绑不改旧会话目标；新绑定/重启重验环境与缓存；未知结果未核实不重复派发。
- [ ] 审批可查固定版本内容、摘要、目标环境；普通 bash 授权不记为包级认可；共享快照核验未实现则保持所有者自用。
- [ ] 默认 120 秒、显式 ≤900 秒、Run 恢复用原截止时间；超时/取消核实原进程。

---

## 5. 收尾：示范技能（§10 末段）

- [ ] DEMO-1 `test-report`：产出 Markdown 报告到 outputDir 并 `artifact_publish` 发布；在 P1 闭环后创建（可直接用 `nova.skills-creater` 起草，作为其首个示范）。
- [ ] DEMO-2 `repo-review`：产出消息形式审查结论；不提前建立一批无法运行的技能目录。

---

## 6. 交付节奏建议

| 批次 | 内容 | 并行建议 |
| ---- | ---- | -------- |
| P0-批1 | A 组、B 组、D1/D2（proto+扫描器） | A/B 一人，D 一人，可并行 |
| P0-批2 | C 组、D3/D4、E 组 | C 与 D 并行，E 依赖两侧 |
| P0-批3 | F 组、G 组 | G2 与 F 并行 |
| P0-批4 | H 组、I 组 | H 可在 C4 契约稳定后提前起 |
| P1 | A1→B1→C1→D1/D2/D3→E1/F1→G1→V1 | 基本串行，C1 与 D3 可并行 |
| P2 | A 组→B1→C 组（C1 可提前）→D/E→V1 | C1 发布校验可与 B1 并行 |

每个批次收尾：相关包 typecheck + 测试、`git diff --check`、更新本文件勾选状态；阶段收尾跑对应 V（验收）清单并记录实际通过/失败/跳过的检查。
