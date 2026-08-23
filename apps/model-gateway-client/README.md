# model-gateway-client

Nova 模型配置模块的独立管理后台。它是 React 前端，不是模型调用 SDK，也不在模型推理路径中。

页面只调用 `/admin/model-config` 管理接口：Provider、模型目录、API Keys、用量和配额。模型推理由 `model-adapters` 直连官方或中转商。

```bash
pnpm --filter @nova/model-gateway-client dev
pnpm --filter @nova/model-gateway-client api:generate
pnpm --filter @nova/model-gateway-client build
```

`src/api/generated/` 由 Orval 生成，禁止手工修改。当前 `openapi.json` 是服务端管理契约快照；服务端导出命令落地后，生成脚本应直接以其导出结果为输入。
