# model-console

Nova 模型配置模块的独立管理后台。它是 React 前端，不是模型调用 SDK，也不在模型推理路径中。

页面只调用 `/admin/model-config` 管理接口：Provider、模型目录、API Keys、用量和配额。模型推理由 `model-adapters` 直连官方或中转商。

本地 Vite 开发默认使用共享 mock 用户“本地开发用户”；生产构建使用 Casdoor 管理会话。

```bash
pnpm --filter @nova/model-console dev
pnpm --filter @nova/model-console api:generate
pnpm --filter @nova/model-console build
```

`src/api/generated/` 由 Orval 从已提交的 `openapi.json` 契约快照生成，禁止手工修改。构建不调用已不存在的 `@nova/agent-server` 包。nova-server 尚未实现快照里的用量统计接口，需先补齐管理端契约，再接入服务端实时导出；不能直接用完整业务 OpenAPI 覆盖当前快照。

生产发布使用本应用的 `.drone.yml`，与 nova-client、nova-server 独立构建和部署。配置与接替旧 nova 的步骤见 [`docs/deployment.md`](../../docs/deployment.md)。
