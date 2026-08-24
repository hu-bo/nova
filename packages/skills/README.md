# @nova/skills

`@nova/skills` 定义 Nova 的可移植 Skill 配置、编译和执行边界。它把本地 JSON、Server 下发配置以及标准 Agent Skills ZIP 归一化为同一种 `nova.skill/v1` 文档，但不连接数据库、不读取 OSS 凭证，也不依赖 `agent-core`。

## 职责

- 严格解析和校验 `nova.skill/v1` JSON。
- 编译 Action 的 JSON Schema、引用关系、Tool 名和内容 checksum。
- 在可终止的 Worker Thread 中运行受控 `node:vm` Action。
- 通过 `SkillHost` 暴露白名单 HTTP 和资源读取能力。
- 安全读取 ZIP，导入标准 `SKILL.md`、`scripts/`、`references/` 和 `assets/`。
- 无损保留市场脚本，但绝不把它们自动升级为可执行 VM Action。

本包不负责 Skill 安装权限、信任等级持久化、用户凭证、数据库、OSS 下载、Agent Session 状态或 UI。

## 目录

```text
packages/skills/
├── skills/                    # 内置 Coding Skills 与示例；未来可换成 Server/DB/OSS
├── src/
│   ├── schema.ts              # nova.skill/v1
│   ├── compile.ts             # 校验、引用解析、JSON Schema 编译
│   ├── runtime.ts             # Worker + VM + capability RPC
│   ├── archive.ts             # 有界 ZIP 读取
│   ├── import-agent-skill.ts  # SKILL.md 转换
│   └── builtins.ts            # 稳定加载内置 Skill 集合
└── test/
```

## SkillDocument

完整示例见 [`skills/weather-assistant.json`](./skills/weather-assistant.json)。主要字段：

```ts
interface SkillDocument {
  format: "nova.skill/v1";
  id: string;
  version: string;
  name: string;
  description: string;
  activation: { mode: "always" | "auto" | "manual"; keywords?: string[] };
  instructions: { markdown: string };
  connections: SkillConnection[];
  resources: SkillResource[];
  actions: SkillAction[];
  metadata: Record<string, string>;
  source: SkillSource;
}
```

`id` 与 `name` 必须一致，使用小写 kebab-case。发布后的 `id + version` 应视为不可变；`compileSkill()` 会对规范化文档生成 SHA-256 checksum。

## 内置 Coding Skills

```ts
import { compileSkills, loadBuiltinSkills } from "@nova/skills";

const codingSkills = loadBuiltinSkills();
const compiled = compileSkills(codingSkills);
```

内置集合刻意保持为 6 个互补 Skill：

| Skill                          | 激活   | 解决的问题                                                |
| ------------------------------ | ------ | --------------------------------------------------------- |
| `minimal-change-engineering`   | always | 最小修改，禁止平行实现、pass-through 层和投机抽象         |
| `codebase-reconnaissance`      | auto   | 修改前定位真实入口、调用链、owner、生成源和已有能力       |
| `root-cause-debugging`         | auto   | 从第一个错误分歧定位根因，避免症状补丁                    |
| `behavioral-verification`      | auto   | 验证真实行为、失败、取消和边界，不测试无意义 wrapper      |
| `change-cleanup-review`        | auto   | 交付前删除 dead code、重复抽象、旧导出和兼容残留          |
| `concurrency-lifecycle-safety` | auto   | 明确并发 owner、上限、backpressure、timeout、retry 和恢复 |

只有最短的最小变更纪律始终进入上下文；其余依赖 metadata 自动激活，避免为了代码质量永久注入大量检查清单。`weather-assistant.json` 只是 VM/API 格式示例，不属于 Coding Agent 默认集合。

### Activation

- `always`：Agent 创建时直接注入完整 instructions。
- `auto`：启动时只暴露 name/description，模型判断后激活。
- `manual`：只接受用户或 Server 显式启用。

本包只编译 activation 数据。`agent-core` 是激活状态 owner，应把 `skillId/version/checksum` 写入 Session Entry，并在后续 Turn 的 System Prompt 中加入已激活 instructions。

### Connections

Connection 只声明可访问范围，不包含密钥：

```json
{
  "id": "weather-api",
  "kind": "http",
  "baseUrl": "https://api.weather.example.com",
  "allowedMethods": ["GET"],
  "allowedPathPrefixes": ["/v1/weather"],
  "auth": {
    "kind": "server-connection",
    "ref": "weather-api"
  }
}
```

Runtime 会校验 Origin、Method、Path 和敏感 Header。真实认证由 `SkillHost.requestHttp()` 根据 `auth.ref` 解析，VM 永远看不到密钥。

### Resources

当前可以内联：

```json
{
  "content": {
    "kind": "inline",
    "encoding": "utf8",
    "data": "resource content"
  }
}
```

未来 DB/OSS 使用对象引用：

```json
{
  "content": {
    "kind": "object",
    "key": "skills/weather/1.0.0/codes.json",
    "sha256": "...64 hex characters...",
    "size": 18240
  }
}
```

对象内容由 `SkillHost.readResource()` 获取。`agent-core` 和本包不直接连接 OSS。

### Actions

Action 会被编译成稳定 Tool 名：

```text
skill__<skill_id>__<action_name>
```

例如：

```text
skill__weather_assistant__query_weather
```

Action 使用标准 JSON Schema 描述输入和输出。`outputSchema` 校验 VM 返回结果的 `details` 字段；供模型消费的简短文本放在 `content`。

```js
async ({ input, sdk }) => {
  const response = await sdk.http.request("weather-api", {
    method: "GET",
    path: "/v1/weather",
    query: { location: input.location },
  });

  return {
    status: "ok",
    content: `天气：${response.data.summary}`,
    details: response.data,
  };
};
```

VM 只获得：

- `sdk.http.request(connectionId, request)`
- `sdk.resources.read(resourceId)`
- `sdk.log.info(message)`

它不会获得 `fetch`、`process`、`require`、文件系统或环境变量。

## 解析与编译

```ts
import { compileSkill, compileSkills } from "@nova/skills";

const skill = compileSkill(json);
console.log(skill.checksum);
console.log(skill.actions.get("query-weather")?.toolName);

const set = compileSkills(serverDocuments);
console.log(set.catalog);
```

编译会拒绝：

- 非法或未知字段。
- 重复 Skill、Connection、Resource、Action 或 Tool 名。
- Action 引用未声明的 Connection/Resource。
- 无效 JSON Schema。
- JavaScript 语法错误。
- 不安全资源路径或非 HTTPS 外部 Origin。

## 执行

```ts
import { compileSkill, executeSkillAction, type SkillHost } from "@nova/skills";

const compiled = compileSkill(json);

const host: SkillHost = {
  async requestHttp({ connection, request, signal }) {
    // 在这里解析 connection.auth.ref、加入凭证、限制响应大小并发起 fetch。
    return { status: 200, data: { summary: "晴" } };
  },

  async readResource({ resource, signal }) {
    // 从 DB/OSS 读取并校验 resource.content.sha256。
    return {
      mediaType: resource.mediaType,
      encoding: "utf8",
      data: "...",
    };
  },
};

const result = await executeSkillAction(compiled, "query-weather", { location: "Shanghai", date: "2026-08-23" }, host, {
  trust: "verified",
  signal: abortController.signal,
  maxResultBytes: 1024 * 1024,
});
```

错误使用稳定 code：`UNTRUSTED_SKILL`、`UNKNOWN_ACTION`、`INVALID_INPUT`、`INVALID_OUTPUT`、`CAPABILITY_DENIED`、`VM_ERROR`、`TIMEOUT`、`CANCELLED`。

## 信任边界

[`node:vm`](https://nodejs.org/api/vm.html) 不是安全沙箱。Worker Thread 提供可终止的 CPU/生命周期边界，但不能让不可信代码变得可信。

强制策略：

- `untrusted` Skill 不能执行 VM Action。
- AI 生成和市场导入的 Skill 初始状态必须是 draft/untrusted。
- `trusted/verified` 不能由 Skill JSON 自己声明，必须由 Server 安装记录决定。
- 发布前应完成 Schema 校验、VM 编译、能力审核、测试和内容签名。
- Server 应限制 HTTP 超时、重定向、响应大小、并发、配额和私网访问。
- 写操作仍应由 `agent-core` 按 Action `risk` 触发审批。

如果未来要运行真正不可信的 JavaScript、Python 或 Shell，应迁移到 Runner/容器/独立执行服务，而不是扩大 VM globals。

## 导入 Agent Skills ZIP

```ts
import { importAgentSkillZip } from "@nova/skills";

const document = importAgentSkillZip(zipBytes, {
  sourceUri: "market://skills/sample.zip",
  archiveLimits: {
    maxEntries: 256,
    maxFileBytes: 4 * 1024 * 1024,
    maxTotalBytes: 16 * 1024 * 1024,
    maxCompressionRatio: 100,
  },
});
```

导入器支持 [Agent Skills 官方规范](https://github.com/agentskills/agentskills/blob/main/docs/specification.mdx) 的标准结构：

```text
sample-skill/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

映射关系：

| Agent Skills       | Nova                                |
| ------------------ | ----------------------------------- |
| frontmatter `name` | `id`、`name`                        |
| `description`      | `description`                       |
| Markdown body      | `instructions.markdown`             |
| `metadata.version` | `version`                           |
| `allowed-tools`    | `source.allowedTools`，只作导入提示 |
| `references/*`     | reference resource                  |
| `assets/*`         | asset resource                      |
| `scripts/*`        | script resource                     |

市场脚本只保存为 Resource，`actions` 保持为空。Python/Bash 无法转换成 Node VM；JavaScript 也可能依赖 Node globals 或 npm 包，所以导入器不会猜测执行语义。后续可以由 AI 生成 Nova Action 草稿，再经过审核发布。

ZIP 读取器拒绝路径穿越、绝对路径、Windows drive path、符号链接、加密、多磁盘、ZIP64、重复/大小写碰撞路径、超限文件和异常压缩比。当前支持 Store 和 Deflate 两种常见压缩方式。

## Agent Core 组装

推荐依赖方向：

```text
agent-core ──► @nova/skills
agent-server ──► @nova/skills
@nova/skills ──╳─► agent-core / server / runner
```

Server 下发完整、锁定版本的 `SkillDocument[]` 和对应信任策略。Agent Core：

1. 调用 `compileSkills()`。
2. 将 `always` instructions 注入 System Prompt。
3. 将 `auto` metadata 放入 Skill Catalog。
4. 注册 `activate_skill`、`read_skill_resource`。
5. 把已激活 Action 包装为 `AgentTool`。
6. 使用 `SkillHost` 和 Server 信任记录调用 `executeSkillAction()`。
7. 将激活状态和 `id/version/checksum` 写入 Session Entry。

本包刻意不返回 `AgentTool`，避免 `@nova/skills` 反向依赖 `agent-core`。JSON Schema 到 Agent Tool Schema 的适配应由 `agent-core` 完成。

## AI 生成与发布

AI 只生成 Skill JSON 草稿，不生成信任等级、真实凭证或免审批策略。推荐发布流水线：

```text
AI JSON
 → parseSkillDocument
 → compileSkill
 → Connection/Capability 策略取交集
 → Evals / dry-run
 → 人工或组织策略审核
 → checksum / 签名
 → 发布不可变版本
```

## 验证

```bash
pnpm --filter @nova/skills typecheck
pnpm --filter @nova/skills test
```
