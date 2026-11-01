import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { Database } from "../database/index.js";
import { createScope, defineRepository, defineService, type Definition, type Scoped } from "../src/shared/scope.js";
import { createUnitOfWork } from "../src/shared/unit-of-work.js";

function database() {
  const stats = { started: 0, committed: 0, rolledBack: 0 };
  const execute = (id: string) => async () => ({ rows: [{ id }] });
  const db = {
    execute: execute("root"),
    async transaction(operation: (tx: object) => Promise<unknown>) {
      const tx = { execute: execute(`tx:${++stats.started}`) };
      try {
        const result = await operation(tx);
        stats.committed++;
        return result;
      } catch (error) {
        stats.rolledBack++;
        throw error;
      }
    },
  } as unknown as Database;
  return { db, stats };
}

const repository = defineRepository(({ db, requireTransaction }) => ({
  async connection() {
    return (await db.execute<{ id: string }>(sql`select 1`)).rows[0]!.id;
  },
  lock() {
    requireTransaction();
    return "locked";
  },
}));

test("scopes bind a complete dependency graph and join nested transactions", async () => {
  const { db, stats } = database();
  const scope = createScope(db);
  const provider = { name: "provider" };
  const child = defineService({ repository, provider }, ({ repository, provider, transaction }) => ({
    read: () => repository.connection(),
    identity: () => ({ repository, provider }),
    atomic: () => transaction(({ repository }) => repository.connection()),
  }));
  const parent = defineService({ child, repository }, ({ child, transaction }) => ({
    plain: () => child.read(),
    run: () =>
      transaction(async ({ child, repository }) => {
        assert.equal(child.identity().repository, repository);
        assert.equal(child.identity().provider, provider);
        return [await child.atomic(), await repository.connection()];
      }),
  }));
  const service = scope.get(parent);
  assert.equal(await service.plain(), "root");
  assert.deepEqual(await service.run(), ["tx:1", "tx:1"]);
  await createUnitOfWork(db).transaction(async (tx) => {
    assert.deepEqual(await service.tx(tx).run(), ["tx:2", "tx:2"]);
    assert.equal(await scope.get(repository).tx(tx).connection(), "tx:2");
  });
  assert.deepEqual(stats, { started: 2, committed: 2, rolledBack: 0 });
  assert.equal(await service.plain(), "root");
});

test("concurrent bindings are isolated and transaction instances expire", async () => {
  const { db, stats } = database();
  const root = createScope(db).get(repository);
  const uow = createUnitOfWork(db);
  let escaped!: Scoped<{ connection(): Promise<string>; lock(): string }>;
  const results = await Promise.all(
    [1, 2].map(() =>
      uow.transaction(async (tx) => {
        const bound = root.tx(tx);
        escaped = bound;
        assert.equal(bound.lock(), "locked");
        await Promise.resolve();
        return [await bound.connection(), await bound.connection()];
      }),
    ),
  );
  assert.deepEqual(results, [
    ["tx:1", "tx:1"],
    ["tx:2", "tx:2"],
  ]);
  assert.throws(() => escaped.connection(), { code: "TRANSACTION_CLOSED" });
  assert.throws(() => root.lock(), { code: "TRANSACTION_REQUIRED" });
  assert.equal(await root.connection(), "root");
  assert.equal(stats.committed, 2);
});

test("caught nested failures force rollback rather than allowing a partial commit", async () => {
  const { db, stats } = database();
  const fault = new Error("nested failure");
  const failing = defineService({}, () => ({
    async fail() {
      throw fault;
    },
  }));
  const parent = defineService({ failing }, ({ transaction }) => ({
    run: () =>
      transaction(async ({ failing }) => {
        try {
          await failing.fail();
        } catch {
          /* Caller recovery cannot commit partial work. */
        }
        return "attempted success";
      }),
  }));
  await assert.rejects(createScope(db).get(parent).run(), { code: "TRANSACTION_ROLLBACK_ONLY", cause: fault });
  assert.deepEqual(stats, { started: 1, committed: 0, rolledBack: 1 });
});

test("repositories require application transactions and expose no transaction factory", async () => {
  const { db, stats } = database();
  const source = defineRepository(({ db, requireTransaction }) => ({
    hasTransactionFactory: () => "transaction" in db,
    async atomic() {
      requireTransaction();
      return (await db.execute<{ id: string }>(sql`select 1`)).rows[0]!.id;
    },
  }));
  const instance = createScope(db).get(source);
  assert.equal(instance.hasTransactionFactory(), false);
  await assert.rejects(instance.atomic(), { code: "TRANSACTION_REQUIRED" });
  await createUnitOfWork(db).transaction(async (tx) => {
    assert.equal(await instance.tx(tx).atomic(), "tx:1");
  });
  assert.deepEqual(stats, { started: 1, committed: 1, rolledBack: 0 });
});

test("snapshot requirements cannot silently upgrade an existing transaction", async () => {
  const { db, stats } = database();
  const service = createScope(db).get(
    defineService({}, ({ transaction }) => ({
      snapshot: () => transaction(async () => "snapshot", { isolationLevel: "repeatable read" }),
      write: () => transaction(async () => "write", { accessMode: "read write" }),
    })),
  );
  const uow = createUnitOfWork(db);
  assert.equal(await service.snapshot(), "snapshot");
  await assert.rejects(
    uow.transaction((tx) => service.tx(tx).snapshot()),
    { code: "TRANSACTION_OPTIONS_MISMATCH" },
  );
  assert.equal(
    await uow.transaction((tx) => service.tx(tx).snapshot(), { isolationLevel: "serializable" }),
    "snapshot",
  );
  await assert.rejects(
    uow.transaction((tx) => service.tx(tx).write(), { accessMode: "read only" }),
    { code: "TRANSACTION_OPTIONS_MISMATCH" },
  );
  assert.deepEqual(stats, { started: 4, committed: 2, rolledBack: 2 });
});

test("bindings reject unmanaged transactions and handles from another database", async () => {
  const { db } = database();
  const other = database();
  const root = createScope(db).get(repository);
  await assert.rejects(
    db.transaction(async (tx) => root.tx(tx).connection()),
    { code: "TRANSACTION_CONTEXT_MISMATCH" },
  );
  await assert.rejects(
    createUnitOfWork(other.db).transaction(async (tx) => root.tx(tx).connection()),
    { code: "TRANSACTION_CONTEXT_MISMATCH" },
  );
});

test("class services preserve private fields, dependency rebinding and method receivers", async () => {
  const { db } = database();
  const repo = createScope(db).get(repository);
  class Service {
    readonly #repository;
    constructor(repository: typeof repo) {
      this.#repository = repository;
    }
    connection() {
      return this.#repository.connection();
    }
  }
  const source = defineService({ repo }, ({ repo }) => new Service(repo));
  const root = createScope(db).get(source);
  await createUnitOfWork(db).transaction(async (tx) => {
    const { connection } = root.tx(tx);
    assert.equal(await connection(), "tx:1");
  });
  assert.equal(await root.connection(), "root");
});

test("circular definitions fail clearly without poisoning future resolutions", () => {
  const { db } = database();
  const scope = createScope(db);
  let recursive!: Definition<object>;
  recursive = defineRepository(() => scope.get(recursive));
  assert.throws(() => scope.get(recursive), { code: "CIRCULAR_DEPENDENCY" });
  assert.throws(() => scope.get(recursive), { code: "CIRCULAR_DEPENDENCY" });
  assert.ok(scope.get(repository));
});

test("lazy queries become one eager Promise with matching inferred types", async () => {
  const { db } = database();
  let executions = 0;
  const source = defineRepository(() => ({
    query() {
      const query: PromiseLike<number> = {
        then(onfulfilled, onrejected) {
          executions++;
          return Promise.resolve(42).then(onfulfilled, onrejected);
        },
      };
      return query;
    },
  }));
  const result: Promise<number> = createScope(db).get(source).query();
  assert.ok(result instanceof Promise);
  assert.equal(await result, 42);
  assert.equal(await result, 42);
  assert.equal(executions, 1);
});

test("repository ports use the same explicit dependency binding as services", async () => {
  const { db, stats } = database();
  const source = defineRepository({ upstream: repository }, ({ db, upstream }) => ({
    async read() {
      return [(await db.execute<{ id: string }>(sql`select 1`)).rows[0]!.id, await upstream.connection()];
    },
  }));
  const port = createScope(db).get(source);
  assert.deepEqual(await port.read(), ["root", "root"]);
  await createUnitOfWork(db).transaction(async (tx) => {
    assert.deepEqual(await port.tx(tx).read(), ["tx:1", "tx:1"]);
  });
  assert.deepEqual(stats, { started: 1, committed: 1, rolledBack: 0 });
});
