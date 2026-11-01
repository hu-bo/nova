# 示例目录

当前完整可执行的 Coding 用法在 [`tests/scenarios/coding.scenario.test.ts`](../tests/scenarios/coding.scenario.test.ts) 中，覆盖真实文件、Git、Node 子进程、工具调用和取消收敛。框架核心不内置 GPU、订单、客服或向量数据库；这些能力应由宿主以工具、Task Handler、Flow 和受控 client 组合接入。

最小 Agent 装配示例见根目录 [README](../README.md)。运行项目门禁：

```sh
pnpm typecheck
pnpm lint
pnpm build
pnpm check:boundaries
pnpm test
```
