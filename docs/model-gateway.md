# model-gateway-client / model configuration

> 服务端模型配置模块已合并到 [agent-server.md](./agent-server.md) §10。
> 本文只保留管理前端和管理 API 的交互说明；模型请求不经过 gateway，也不经过
> `agent-server` 代理。服务端实现、数据 owner 和未来拆分边界以 `agent-server.md` 为准。

> `apps/model-gateway` — 模型配置管理模块的历史文档入口，不是 Nova 推理代理。
> `apps/model-gateway-client` — 它的管理后台前端（§7）。
> 服务端结构契约见 `agent-server.md` §10；本文主要保留管理端交互说明。

---

## 1. 定位

**服务端模块归属 `agent-server`，但逻辑独立于 Agent / Runner / SSE。** 当前与
`agent-server` 同进程部署；未来可按 `agent-server.md` §10 的稳定契约拆成独立服务。

**负责**

- Provider 配置与模型目录管理
- 模型注册与映射：对外统一模型名，对内路由到具体 provider
- 用量计量、计费、配额与限流

**不提供推理面**：不提供 `/v1/chat/completions`、`/v1/messages` 或模型 SSE 代理接口。模型请求由 `model-adapters` 根据 `agent-server` 下发的配置直接连接官方或中转商。

**不负责**：Prompt 构造、Agent 语义、会话状态、Execution / Runner 相关的一切。

**依赖**：只依赖稳定的模型配置契约，不依赖 Agent、Runner、Conversation 或 SSE 实现。

**技术栈**：Fastify + PostgreSQL + Drizzle（结构遵循 `Fastify.md`）

---

## 2. 关键约束：不新增调用层

```text
agent-core → model-adapters ──HTTP/SSE──► 官方或中转商

❌ agent-core → model-adapters → model-gateway → provider
```

模型配置复用 `packages/model-adapters` 已有的数据路径，由 `agent-server` 下发官方或中转商
的 endpoint、模型名和凭据。**不允许**为 gateway 单独新增客户端包
—— 那会退化成 pass-through。

由于本服务暴露 OpenAI 兼容接口，`model-adapters` 侧大概率只需换 `baseUrl` + token，
连 `gateway.ts` 都不用建（`model-adapters.md` §7）。

**两条正交的路径**

```text
配置路径   model-gateway-client ──HTTP──► model-gateway ──配置──► agent-server
推理路径   agent-core → model-adapters ──直连──► 官方或中转商
```

管理后台**不在推理数据路径上**。这是 §7 命名歧义的关键。

---

## 3. 对外接口

### 推理面（已移除）

本服务不接收模型推理请求，不转发请求/响应和 SSE。以下路径不属于本服务契约：

| Path | 兼容 |
|---|---|
| `POST /v1/chat/completions` | 不提供 |
| `POST /v1/messages` | 不提供 |
| `GET /v1/models` | 不提供 |

以上路径仅用于明确“不属于本服务”；本服务没有推理鉴权、请求转发或 SSE 透传契约。

### 管理面

前缀 `/admin`，做 Casdoor 登录鉴权，并额外要求 `admin` 角色；不引入其他角色、团队或 ACL 模型。
管理端请求带 `Authorization: Bearer <Casdoor access token>`；gateway 服务端校验签名、issuer、
audience 和过期时间后，再校验认证结果中的 `admin` 角色，满足后才可进入管理路由。
登录成功但没有 `admin` 角色返回 `403 Forbidden`，不能降级为普通登录用户访问管理接口。

`admin` 是 `/admin` 的唯一角色判断：provider、model、api-key、usage、quota 的所有管理接口
统一使用这条规则；不为不同资源再拆分权限。Casdoor 的其他角色、团队、ACL 和 Casbin policy
不进入本阶段契约。

本服务没有推理鉴权。管理面使用 Casdoor；模型直连所需凭据由模型配置流程安全地下发给
`agent-server`，不通过本服务转发请求。

| Method | Path | 用途 |
|---|---|---|
| `GET/POST/PATCH/DELETE` | `/admin/providers` | provider 凭据；DELETE 为逻辑删除并擦除密文 |
| `GET/POST/PATCH/DELETE` | `/admin/models` | 模型映射；DELETE 为逻辑删除 |
| `GET/POST/DELETE` | `/admin/api-keys` | 下发给业务侧的 key；DELETE 表示不可逆吊销 |
| `GET` | `/admin/usage` | 用量报表（按 key / 模型 / 时间） |
| `GET/PATCH` | `/admin/quotas` | 配额与限流策略 |

---

## 4. 数据模型

**五张逻辑表。** `usage` 是按月分区的分区表及其子分区，不额外算业务实体。

```ts
providers
  id                    uuid pk
  protocol              text not null  // "openai" | "anthropic"；表示 upstream wire format
  name                  text not null unique
  base_url              text not null
  credential_enc        text null      // 可逆加密封装；删除后清空
  enabled               boolean not null
  created_at            timestamptz not null
  updated_at            timestamptz not null
  deleted_at            timestamptz null
  check protocol in ('openai', 'anthropic')
  check (deleted_at is null) = (credential_enc is not null)
  check deleted_at is null or enabled = false

models
  id                  uuid pk
  public_name         text not null unique  // 对外统一名，如 "nova-fast"
  provider_id         uuid not null fk → providers on delete restrict
  upstream_name       text not null         // provider 侧真名
  context_window      int not null
  max_output          int not null
  thinking_levels     text[] not null       // off / low / medium / high / max；空数组 = 不支持
  parallel_tool_calls boolean not null
  reasoning_format    text not null         // none / openai / anthropic / deepseek / minimax
  input_modalities    text[] not null       // 当前只允许 text / image，且必须包含 text
  enabled             boolean not null
  price_in            numeric(20, 8) not null  // 每百万 token，统一结算币种
  price_out           numeric(20, 8) not null
  price_cache_read    numeric(20, 8) not null  // 无单独折扣时等于 price_in
  created_at          timestamptz not null
  updated_at          timestamptz not null
  deleted_at          timestamptz null
  check context_window > 0 and max_output > 0 and max_output <= context_window
  check thinking_levels <@ array['off', 'low', 'medium', 'high', 'max']::text[]
  check (reasoning_format = 'none') = (cardinality(thinking_levels) = 0)
  check reasoning_format in ('none', 'openai', 'anthropic', 'deepseek', 'minimax')
  check input_modalities <@ array['text', 'image']::text[] and 'text' = any(input_modalities)
  check price_in >= 0 and price_out >= 0 and price_cache_read >= 0
  check deleted_at is null or enabled = false

api_keys
  id            uuid pk
  key_prefix    text not null       // 列表展示与安全定位，不足以认证
  key_digest    bytea not null unique
  digest_key_version int not null
  name          text not null
  owner_id      text not null       // gateway 自身的租户标识，不引用 Nova project 表
  enabled       boolean not null
  created_at    timestamptz not null
  revoked_at    timestamptz null
  check revoked_at is null or enabled = false
  index (owner_id, created_at desc, id desc)

usage
  created_at  timestamptz not null
  id          uuid not null
  api_key_id  uuid not null fk → api_keys on delete restrict
  model_id    uuid not null fk → models on delete restrict
  status      text not null       // completed / aborted / error
  input       bigint not null
  output      bigint not null
  cache_read  bigint not null default 0
  cost        numeric(20, 8) not null
  estimated   boolean not null default false
  pk (created_at, id)             // 分区唯一键必须包含 created_at
  check status in ('completed', 'aborted', 'error')
  check input >= 0 and output >= 0 and cache_read >= 0 and cache_read <= input and cost >= 0
  index (api_key_id, created_at desc)
  index (model_id, created_at desc)
  partition by range (created_at)

quotas
  api_key_id   uuid pk fk → api_keys on delete cascade
  rpm          int null               // null = 不限
  tpm          bigint null
  monthly_cost numeric(20, 8) null
  updated_at   timestamptz not null
  check rpm is null or rpm > 0
  check tpm is null or tpm > 0
  check monthly_cost is null or monthly_cost >= 0
```

`usage` 会长得很快，建表时按 `created_at` 做 UTC 月度分区。迁移必须提前创建下个月分区，
并保留 default partition 防止跨月时写入失败。PostgreSQL 要求分区表的主键包含分区键，
所以不能使用原设计的 `id uuid primary key`。归档或删除分区前先按数据保留策略处理。

Provider、Model 和 API key 被 usage 引用后不能物理删除。管理面的 DELETE 是明确的领域动作：
Provider 置 `deleted_at`、禁用关联 Model，并在同一事务中擦除 `credential_enc`；
Model 置 `deleted_at` 并禁用；API key
置 `revoked_at` 并禁用。历史 usage 的外键因此保持有效，默认列表过滤已删除资源。
`public_name` 和资源名称删除后也不复用，避免旧配置在未来悄悄指向另一项资源。

`models` 同时是路由表和模型能力目录。管理面写入时应校验 `thinking_levels` 无重复值；
`reasoning_format = 'none'` 时它必须为空。其余组合按具体模型能力配置，例如某个模型不能关闭
thinking，就不要把 `off` 放进数组。不能只按 provider 推断这些值：同一 OpenAI 中转商下面的
不同模型可能来自不同上游、具有不同上下文和 reasoning 协议。

这些字段由配置管理面提供给 `agent-server`，并一一映射到 `ModelRef`：provider 的 `protocol → protocol`、
`public_name → model`、`context_window →
contextWindow`、`max_output → maxOutput`、`thinking_levels → thinkingLevels`、
`parallel_tool_calls → parallelToolCalls`、`reasoning_format → reasoningFormat`、
`input_modalities → inputModalities`。`provider_id` 只用于配置管理关联；`upstream_name`、
`base_url` 和连接凭据由 agent-server 按安全配置下发给 `model-adapters`，用于直接连接官方或
中转商。它们不指向 model-gateway 的推理地址。

`protocol` 与 `reasoning_format` 必须分开：前者决定调用 `/v1/chat/completions` 还是
`/v1/messages`，后者决定同一协议内 thinking 参数的供应商差异。例如 MiniMax 和 DeepSeek
都可配置为 `protocol = 'anthropic'`，但仍分别使用 `reasoning_format = 'minimax'` 和
`'deepseek'`。OpenAI 中转商使用 `protocol = 'openai'`，其下每个模型单独配置 reasoning 格式。

当前三类上游的推荐配置：

| 上游 | provider `protocol` | provider `base_url` | model `reasoning_format` |
|---|---|---|---|
| MiniMax Anthropic | `anthropic` | `https://api.minimax.io/anthropic` | `minimax` |
| DeepSeek Anthropic | `anthropic` | `https://api.deepseek.com/anthropic` | `deepseek` |
| OpenAI 中转商 | `openai` | 中转商给出的、通常以 `/v1` 结尾的 URL | 按实际模型填 `openai` / `deepseek` / `minimax` / `none` |

`price_cache_read` 不允许为 null，否则账单无法判定缓存 token 应按原价还是免费计算；没有独立
缓存价格的 provider 直接填 `price_in`。成本按 `(input - cache_read) × price_in + cache_read ×
price_cache_read + output × price_out` 计算（各价格均为每百万 token），因此数据库同时约束
`cache_read <= input`。

---

## 5. 密钥处理

| 项 | 做法 |
|---|---|
| provider 密钥 | 使用 AES-256-GCM 可逆加密；nonce、ciphertext、auth tag 封装成一个 `credential_enc` 字符串 |
| 主密钥 | 第一版只使用一个 `MODEL_GATEWAY_SECRET`，**不入库、不进代码、不进镜像**，从 Secret Manager 或环境注入 |
| gateway api-key | 生成至少 256-bit 随机值；存 `HMAC-SHA-256(pepper, key)` 与非敏感 prefix，明文仅创建时返回一次 |
| 管理面返回 | provider 密钥一律脱敏 `sk-...abcd`，没有"查看明文"接口 |
| 日志 | 请求体里的 key 与 prompt **一律不落日志** |

密钥托管是本服务存在的首要理由。这一节做砸了，服务就是负价值。

`credential_enc` 使用固定的版本化文本格式，例如：

```text
v1.<base64url(nonce | ciphertext | auth_tag)>
```

加密函数内部每次生成随机 12-byte nonce；解密函数读取 `v1`，拆出 nonce、ciphertext 和 tag，
再用 `MODEL_GATEWAY_SECRET` 还原明文。数据库只认识这一列，不分别管理密码学参数。`v1` 为以后
更换格式保留迁移入口，但第一版不实现多主密钥和在线轮换。Base64url 只是密文编码，不是加密。

API key 是高熵机器凭据，不使用 bcrypt / argon2 这类面向低熵密码的慢哈希；HMAC pepper 与
provider 主密钥分离管理，`digest_key_version` 支持轮换。认证时对 digest 做 constant-time
比较。provider `base_url` 只允许 HTTPS 和配置允许的 host；loopback、link-local 和私网目标
默认拒绝，确有内网 provider 时必须由部署级 allowlist 明确放行，防止管理配置形成 SSRF。

---

## 6. 计量与限流

**计量时机**：每个请求先生成内部 request id；流正常结束后从上游 usage 字段取数落
`usage` 表。上游没给 usage 就用与模型匹配的 tokenizer 估算并置 `estimated = true`。
客户端中断或上游错误也写终态 usage；无法得到的计数写 0 并标记 estimated，不能伪装成完整计量。

**限流**：单实例使用进程内滑动窗口；多实例部署前必须切换到 Redis 这一唯一 owner，不能同时
用两套计数器再尝试合并。
超限返回 `429` 带 `Retry-After` —— `model-adapters` 的重试逻辑认这个头（`model-adapters.md` §5）。

**配额**：月度金额超限返回 `402`，不重试。

> `429` 和 `402` 的区别要严格：前者是"等会儿再来"，后者是"别来了"。
> 搞混会让客户端在配额耗尽后无限重试。

---

## 7. `model-gateway-client`

model-gateway 的**管理后台前端**。与 `agent-web-ui` 平级，都是 React 应用。

**负责**：配置 provider 凭据、接入调试新模型（DeepSeek / MiniMax）、
模型映射与配额的可视化管理、用量与计费报表。

**不负责**：不在推理数据路径上；不承载任何 Agent / TaskFlow / Execution 语义。

**依赖**：仅 `apps/model-gateway` 的 `/admin` 接口（+ Casdoor 登录与 `admin` 角色）。

> **命名提示**：它叫 "client" 是相对 model-gateway 而言的**前端**，
> **不是**"调用 gateway 的 SDK"。两者混淆会直接导致 §2 禁止的 pass-through 层。
> 这个误读在 `repo-layout.md` §6.2 已经发生过一次，值得在文件头再写一遍。

### 7.1 技术栈与状态边界

```text
model-gateway /admin → OpenAPI → Orval → React Router → TanStack Query
                                                        │
                         ┌──────────────────────────────┼──────────────────────────────┐
                         ▼                              ▼                              ▼
                   路由 / 页面组合                 服务端资源缓存                 表单瞬时状态
                                                                               React Hook Form + Zod
```

| 层 | 选型 | 在本 app 中的职责 | 不承担的职责 |
|---|---|---|---|
| HTTP 契约 | `@fastify/swagger` + OpenAPI | `model-gateway` 的 `/admin` REST 契约唯一来源 | 不根据页面需求手写路径、DTO 或枚举 |
| 契约与客户端 | OpenAPI + Orval | 生成请求函数、请求/响应类型和 TanStack Query hooks | 不手写与 schema 重复的 `fetch` 包装 |
| 路由 | React Router | URL、嵌套路由、页面级错误边界与加载态 | 不保存服务端资源副本 |
| 服务端状态 | TanStack Query | provider、模型、API key、quota、usage 等可重新获取资源的缓存、失效、预取与轮询 | 不保存未提交的密钥或表单草稿 |
| 表单 | React Hook Form + Zod | 新建/编辑 provider、model、key、quota 的输入与客户端校验 | 不替代服务端校验或密钥加密 |
| 组件基础 | shadcn/ui + Base UI | 可访问的表格、Dialog、Sheet、Menu、Popover、Toast 等基础原语 | 不另建一套业务组件或设计系统 |
| 样式 | Tailwind CSS v4 | 主题 token、响应式布局、暗色模式、状态样式 | 不在页面散落硬编码颜色与间距 |
| 视觉反馈 | Lucide + Motion | 图标、150–250ms 的非关键反馈与折叠动画 | 不以动画掩盖保存、校验或网络失败 |

**状态必须分开。** Query cache 只保存可从 `/admin` 再取回的数据；Dialog 开关、筛选输入、
表单草稿和一次性明文 key 只活在组件局部状态。provider 密钥与新建 API key 的明文**绝不**写入
Query cache、URL、持久化存储、错误对象或日志。

### 7.2 OpenAPI / Orval 约定

- `model-gateway` 通过 `@fastify/swagger` 从每个 `/admin` route 的 schema 导出 OpenAPI；管理端以该文档为唯一 REST 契约来源。
- Orval 输入为 gateway 的 OpenAPI JSON，输出固定在 `src/api/generated/`，**只读、不手改**。生成命令和配置必须在 `package.json` 中可发现。
- 生成的 mutator 统一注入 Casdoor Bearer token；gateway 对无效登录返回 `401`、缺少 `admin` 角色返回 `403`，mutator 将非 2xx 响应转换成统一的 UI 错误；业务代码不得绕过它再造第二个 HTTP client。
- 业务代码只从 `src/api/` 的稳定出口使用生成类型和 hooks；该目录允许定义 query key、轮询周期、失效关系和极薄的展示适配，不能重声明 API type。
- 服务端 OpenAPI 变更与生成产物必须同一提交；CI 运行生成命令后检查工作区无 diff，防止管理端与服务端契约漂移。

推荐的资源 key 形状：

```ts
const queryKeys = {
  providers: ["providers"] as const,
  provider: (providerId: string) => ["providers", providerId] as const,
  models: ["models"] as const,
  model: (modelId: string) => ["models", modelId] as const,
  apiKeys: ["api-keys"] as const,
  quotas: ["quotas"] as const,
  usage: (filters: UsageFilters) => ["usage", filters] as const,
}
```

`usage` 的时间范围、key、模型等筛选条件属于 query key；provider 密钥、API key 明文、
Dialog 状态和正在编辑的表单对象不属于。

### 7.3 页面与交互

页面：`/providers`、`/models`、`/keys`、`/usage`、`/quotas`。provider、模型、key 与 quota
是管理资源；`usage` 为只读报表。不增加任何推理或 Agent 页面。

- Provider 和模型的创建/编辑使用 RHF + Zod；服务端字段错误映射回字段，其余错误显示为可关闭的表单级提示。提交失败不清空输入，成功后才 reset、关闭 Dialog 并失效对应 query。
- 创建 API key 的成功响应只在一次性 Dialog 中展示明文，支持复制和明确的“我已保存”关闭动作；关闭后立即从组件状态清除。列表只展示服务端返回的掩码与元数据。
- Provider、model、key、quota 的 mutation 成功后失效自身列表及所有受影响的关联资源；删除和禁用操作必须有可访问的确认 Dialog，不能只依赖颜色或图标表达风险。
- usage 报表以筛选条件驱动 Query，可轮询但不乐观更新；计量延迟、估算值和空结果应以明确文案呈现，而不是伪造实时精度。
- shadcn/ui 的 Dialog、Menu、Popover、Sheet 必须保留键盘导航、Esc 关闭、焦点恢复和可读名称。状态色同时配文字、图标或 aria 文本；Motion 尊重 `prefers-reduced-motion`。

### 7.4 目录结构

```text
apps/model-gateway-client/src/
├── main.tsx
├── app.tsx                   # Router、QueryClient、Casdoor 与全局 provider
├── api/
│   ├── generated/            # Orval 输出：禁止手改
│   ├── client.ts             # token 注入、统一错误映射
│   └── query-keys.ts         # 稳定 key 工厂与失效关系
├── components/
│   └── ui/                   # shadcn/ui 原语，不放业务逻辑
├── routes/
│   ├── providers.tsx
│   ├── models.tsx
│   ├── keys.tsx
│   ├── usage.tsx
│   └── quotas.tsx
├── providers/                # provider 表单、mutation 与展示适配
├── models/                   # model 表单、mutation 与展示适配
├── api-keys/                 # 一次性明文展示与 key 管理
├── quotas/                   # 配额策略表单
└── auth/
    └── provider.tsx
```

不建全局 `stores/`、`services/` 或手写 `api-types/`。资源缓存归 TanStack Query，
表单归页面 feature，HTTP 类型归 OpenAPI 生成产物。

---

## 8. Phase 范围

**当前范围**：管理端配置、模型目录、用量和配额页面；服务端范围见 `agent-server.md` §10。

**Phase 1 明确不做。** 走 `model-adapters → provider-compatible endpoint` 直连，
使集成测试不依赖 gateway 服务与建库，核心闭环最快打通（`repo-layout.md` §6.2）。

**按需**：多 provider 故障转移、按成本路由、prompt 缓存、请求录制回放。
每一项都要先有明确的痛点再做 —— 网关最容易长成什么都想管的怪物。
