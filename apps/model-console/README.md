# model-console

Nova 模型配置模块的独立管理后台。它是 React 前端，不是模型调用 SDK，也不在模型推理路径中。

页面只调用 `/admin/model-config` 管理接口：Provider、模型目录、API Keys、用量和配额。模型推理由 `model-adapters` 直连官方或中转商。

认证默认使用 Casdoor。仅在本地 Vite 开发且显式设置 `VITE_AUTH_MODE=dev` 时使用共享 mock 用户“本地开发用户”；生产构建始终使用 Casdoor 管理会话。

```bash
pnpm --filter @nova/model-console dev
pnpm --filter @nova/model-console api:generate
pnpm --filter @nova/model-console typecheck
pnpm --filter @nova/model-console test
pnpm --filter @nova/model-console build
```

## 目录与依赖

采用 React + TanStack Router 文件路由。路由树由 CLI 和 Vite 插件自动生成，生产页面自动按路由拆包。

```text
src/
  app/                # 应用组装、providers、router、导航、后台布局与路由反馈
  routes/             # 文件路由：路径、参数校验、鉴权、页面挂载
  pages/              # 完整页面入口及页面内的交互和业务能力组合
  features/           # auth、providers、models、usage 的表单、schema、查询和 mutation
  components/         # 跨业务通用组件，ui/ 放基础组件封装
  api/                # Orval 生成代码、请求执行、错误、会话凭据适配
  lib/                # 无业务含义的公共工具
  styles/             # 全局样式与主题变量
  routeTree.gen.ts    # 生成的路由树，禁止手动修改
tests/                # API 与路由集成测试
```

- 依赖方向：`app/routes -> pages -> features -> components/api/lib`。路由也可直接使用 feature 的参数 schema。
- 页面统一放在 `pages/<page>/<page>-page.tsx`；可复用业务能力留在 `features/`，不另建 `features/*/pages`。
- 外部调用 feature 使用其 `index.ts`；feature 不导入页面、应用组装或路由文件，不形成循环依赖。
- 页面负责组合多个 feature。Provider 写操作通过 models 的公开缓存键使关联模型失效；models 不反向依赖 providers。
- URL 管理已应用的筛选条件，Query 管理服务端数据，表单管理未提交草稿，局部交互使用 React state。
- API 类型以生成代码为准；业务表单 schema 与 query options 由对应 feature 管理。

`_authenticated` 是不占 URL 路径的布局路由，`beforeLoad` 将匿名访问转到 `/login` 发起 SDK 登录，登录回调恢复原路径、查询参数与 hash。`/callback` 不受登录检查限制。初次会话恢复完成后，SDK 登录或换取凭据的 loading 状态不会卸载回调页面。

用量页面通过 `validateSearch` 校验日期与状态；表单草稿随 URL 导航重新初始化。未知路径展示 404，页面加载错误提供重试。

`src/api/generated/` 由 Orval 从已提交的 `openapi.json` 契约快照生成，禁止手工修改。构建不调用已不存在的 `@nova/agent-server` 包。nova-server 尚未实现快照里的用量统计接口，需先补齐管理端契约，再接入服务端实时导出；不能直接用完整业务 OpenAPI 覆盖当前快照。

生产发布使用本应用的 `.drone.yml`，与 nova-client、nova-server 独立构建和部署。配置与接替旧 nova 的步骤见 [`docs/deployment.md`](../../docs/deployment.md)。
