# @hquant/logger-js

基于 [pino](https://github.com/pinojs/pino) 的轻量日志封装：

- 开发环境：使用 `pino-pretty`，彩色可读输出到 stdout
- 生产环境：stdout 输出结构化 JSON，同时使用 `pino-transport-rotating-file` 滚动写入可读文件
- 测试环境：stdout 输出 JSON；可注入 destination 捕获日志

> 配置在创建 logger 时读取；可通过 options 显式覆盖环境、级别和目录。

## 安装

> 说明：当前包在 `package.json` 中标记为 `private: true`，通常用于本仓库（pnpm workspace）内部引用。

在 monorepo（pnpm workspace）中，在“使用方”应用/包里添加依赖（将 `<consumer>` 替换为你的包名或路径，例如 `apps/trader-service`）：

```bash
pnpm --filter <consumer> add @hquant/logger-js@workspace:*
```

运行时依赖说明：本包内部会按环境加载如下 transport target：

- 开发环境：`pino-pretty`
- 生产环境：`pino-transport-rotating-file`

这些 transport 及其 peer dependencies 已声明在本包中，使用方无需重复添加。开发前先构建本包。

## 使用

```ts
import { createLogger } from "@hquant/logger-js";

const logger = createLogger("trader-service");

logger.info("service started");
logger.warn({ symbol: "BTC-USDT" }, "price spike");
logger.error(new Error("boom"), "unexpected error");

// 子模块 logger（scope）
const apiLogger = logger.child({ scope: "api" });
apiLogger.info({ path: "/health" }, "request");
```

### 字段约定

- `service`：创建 logger 时传入的服务名（必填）
- `scope`：通过 `logger.child({ scope })` 创建的模块/子系统名；也可绑定 runId 等结构化字段
- `env`：`NODE_ENV`
- `time`：ISO 时间戳（字符串）

## 环境变量

- `NODE_ENV`：环境（默认 `development`）
- `LOG_LEVEL`：日志级别（默认 `info`）
- `LOG_DIR`：生产环境日志目录（默认 `logs`）

示例：

```bash
export NODE_ENV=production
export LOG_LEVEL=info
export LOG_DIR=/var/log/trader
```

## 生产环境日志文件

生产环境使用按天滚动：

- 文件名由 transport 生成，前缀为服务名，以 `.log` 结尾
- 按 `1d` 或单文件 `20M` 滚动
- 保留天数：`30`（`retentionDays: 30`）
- 自动创建目录；进程退出时由 Pino transport 刷新并关闭

## 开发

在仓库根目录：

```bash
pnpm --filter @hquant/logger-js build
pnpm --filter @hquant/logger-js lint
pnpm --filter @hquant/logger-js test
```

## API

### `createLogger(service: string, options?: LoggerOptions, destination?: DestinationStream)`

- `service`：服务名（必填；为空会抛错）
- options：Pino `LoggerOptions` 加 `environment`、`directory`，支持 level、base、timestamp、redact、serializers
- destination：提供时直接写入该 stream，跳过默认 transport，便于测试
- 返回原生 Pino logger，保留 `child(bindings, options)` 等方法和实例行为，可作为 Fastify 的 `loggerInstance`
- 原封装的 `child('scope')` 改为 Pino 原生的 `child({ scope: 'scope' })`
