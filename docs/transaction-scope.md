# Repository / Service 事务作用域

实现位于 `apps/nova-server/src/shared/scope.ts`，入口是 `defineRepository`、`defineService` 和 `createScope`。现有 `createXxxRepository(db)` 工厂返回带 `.tx(tx)` 的实例；业务模块通过 Scope 组装 Service。普通对象和 class 使用同一套绑定机制。

## 调用方式

```ts
const repository = createRunnerTokenRepository(db);
const uow = createUnitOfWork(db);

// 普通写入：单条 SQL 独立提交。
await repository.markRotated(tokenId, ownerId, true);

await uow.transaction(async (tx) => {
  const tokens = repository.tx(tx);
  await tokens.lock(tokenId, ownerId);
  await tokens.markRotated(tokenId, ownerId, true);
});
```

`.tx(tx)` 返回当前事务作用域中的实例，不修改原实例。同一个定义在一个 Scope 内只构造一次；多个 Repository / Service 传入同一个 `tx`，共同参与该事务。

`tx` 必须来自 `createUnitOfWork(db).transaction()` 或 Scope 管理的事务。框架拒绝原生 `db.transaction()` 产生的未托管句柄，以及其他 Database 实例的句柄。这样才能可靠检查事务生命周期和嵌套语义，不能把未托管事务静默当成一个长期有效的上下文。

## 定义 Repository

```ts
export const projectRepository = defineRepository(({ db }) => ({
  async findById(input: { id: string; ownerUserId: string }) {
    // SQL 统一使用这里的 db；不要捕获根数据库。
  },
}));

export function createProjectRepository(db: Database) {
  return createScope(db).get(projectRepository);
}
```

`db` 是当前上下文的数据库适配器，只暴露查询操作。根 Scope 使用根数据库；事务 Scope 使用已绑定的事务连接。Repository 方法返回业务结果或 Promise，查询构建器在 Repository 内完成。

需要行锁的操作调用 `requireTransaction()`，防止事务外加锁后立即释放造成误用：

```ts
export const tokenRepository = defineRepository(({ db, requireTransaction }) => ({
  async lock(id: string) {
    requireTransaction();
    // 使用 db 查询，并附加 FOR UPDATE。
  },
}));
```

Repository 不拥有事务工厂。运行、会话和模型配置的复合操作由对应 Service 的 `transaction()` 声明边界，Repository 调用 `requireTransaction()` 验证前置条件。快照操作还可以调用 `requireTransaction({ isolationLevel: "repeatable read" })` 校验隔离级别，阻止弱快照绕过应用层。ESLint 禁止 Repository 调用 `.transaction()`。

## 定义 Service

Service 声明依赖，工厂只从参数中获取依赖，不捕获根 Repository 或根 Service。

```ts
export const projectService = defineService({ projects: projectRepository }, ({ projects, transaction }) => ({
  get(input: { id: string; ownerUserId: string }) {
    return projects.findById(input);
  },

  rename(input: { id: string; ownerUserId: string; name: string }) {
    return transaction(async ({ projects }) => {
      const current = await projects.findById(input);
      if (!current) throw new DomainError("NOT_FOUND", "Project not found");
      return projects.update(input);
    });
  },
}));

// 仅在组合入口解析定义。
const service = createScope(db).get(projectService);
await service.rename(input);

await createUnitOfWork(db).transaction(async (tx) => {
  await service.tx(tx).rename(input);
});
```

依赖可以是 Repository/Service 定义，也可以是已由 Scope 创建的实例。框架会递归重建依赖链，并在事务 Scope 内缓存；普通配置、客户端、存储等未托管对象保持原实例。持久化依赖必须通过框架声明和构造，普通对象里的隐式数据库依赖不会被自动发现。

class 作为工厂结果时保留私有字段和方法接收者。业务类注入同一个 `ServiceTransaction<依赖>`，事务回调直接接收已绑定的依赖：

```ts
const definition = defineService(
  { repository: runnerTokenRepository },
  ({ repository, transaction }) => new RunnerTokenService(repository, transaction, encryptionKey),
);

const service = createScope(db).get(definition);
```

直接 `new Service(...)` 适合显式注入测试替身；需要 `.tx(tx)` 和自动依赖绑定时，通过 Scope 构造实例。工厂每次构造必须返回新对象，不能返回共享单例。`tx` 是实例保留方法名，`transaction` 是 Service 上下文的保留字段名。

## 事务规则

- 普通调用不会统一包事务。多步写入由业务方法显式调用 `transaction()`；已绑定的 Service 自动加入已有事务，最外层负责提交和回滚。
- 任一已绑定操作或内层事务失败，整个事务进入 rollback-only 状态。外层即使捕获错误，也不能提交此前的部分写入；需要继续工作时重新开始一个事务。
- 嵌套操作要求更强隔离级别、在只读事务中要求可写，或要求外层未提供的 deferrable 语义时，抛出 `TRANSACTION_OPTIONS_MISMATCH`。外层应提前声明整个用例需要的事务选项。
- 事务结束后，绑定实例不能继续调用或绑定其他事务，抛出 `TRANSACTION_CLOSED`。不要缓存事务实例，也不要从事务回调中启动不等待的数据库工作。
- 不使用 AsyncLocalStorage 隐式切换根实例。事务回调中误用原始根 Repository 仍然走根数据库；应使用回调提供的依赖或 `.tx(tx)` 实例。
- SSH、Runner、对象存储等外部副作用不随数据库事务回滚。它们的准备、持久化与派发边界仍由业务用例负责。

所有跨模块公开 port 都使用绑定后的依赖，不再把原始事务作为业务方法参数。`ConversationReader.readOwnedHead(input)`、`RunnerReader.readWorkspace(input)`、`ConversationEventHeads.lock(ids)`、`runJournal.append(conversation, event)` 和事件写入器由 Scope 递归绑定。运行聚合内部的私有 SQL helper 可以接收已有事务，但不会导出第二套兼容接口。

Repository 依赖其他模块的公开 port 时使用同样的依赖声明：

```ts
const repository = defineRepository({ events: eventWriter }, ({ db, events, requireTransaction }) => ({
  async save(input: SaveInput) {
    requireTransaction();
    // db 与 events 已绑定同一个上下文。
  },
}));
```

`tests/scope.test.ts` 验证作用域、依赖绑定、嵌套、并发、隔离级别和生命周期。`tests/chat-protocol.integration.test.ts` 使用独立 PostgreSQL schema 验证跨模块写入真正一起提交或回滚。
