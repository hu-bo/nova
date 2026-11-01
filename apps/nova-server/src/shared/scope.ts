import type { Database } from "../../database/index.js";
import type { Transaction, UnitOfWork } from "./unit-of-work.js";

export type TransactionOptions = NonNullable<Parameters<Database["transaction"]>[1]>;
export type RepositoryDatabase = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;
type Dependencies = Record<string, unknown>;
type Resolved<D> = { [K in keyof D]: D[K] extends Definition<infer T> ? Scoped<T> : D[K] };
export type ServiceTransaction<D extends Dependencies> = <R>(
  operation: (dependencies: D) => Promise<R>,
  options?: TransactionOptions,
) => Promise<R>;
type LazyMethods<T> = {
  [K in keyof T]: T[K] extends (...args: infer _A) => infer R
    ? R extends PromiseLike<unknown>
      ? R extends Promise<unknown>
        ? never
        : K
      : never
    : never;
}[keyof T];
type Eager<T extends object> = [LazyMethods<T>] extends [never]
  ? T
  : {
      [K in keyof T]: T[K] extends (...args: infer A) => PromiseLike<infer R>
        ? (...args: A) => Promise<Awaited<R>>
        : T[K];
    };
export type Scoped<T extends object> = T & { tx(transaction: Transaction): Scoped<T> };
type Factory<T extends object> = (scope: Scope) => T;
const definition = Symbol("scope.definition");

export interface Definition<T extends object> {
  readonly [definition]: Factory<T>;
}

export class ScopeError extends Error {
  constructor(
    readonly code:
      | "TRANSACTION_CLOSED"
      | "TRANSACTION_REQUIRED"
      | "TRANSACTION_ROLLBACK_ONLY"
      | "TRANSACTION_CONTEXT_MISMATCH"
      | "TRANSACTION_OPTIONS_MISMATCH"
      | "CIRCULAR_DEPENDENCY",
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = "ScopeError";
  }
}

type TransactionState = {
  tx: Transaction;
  options: TransactionOptions;
  closed: boolean;
  failed: boolean;
  cause?: unknown;
};

// Explicit handles only; no ambient transaction or request-local global state.
const transactions = new WeakMap<Transaction, Scope>();
const instances = new WeakMap<object, { scope: Scope; source: Definition<object> }>();
const isolation = { "read uncommitted": 0, "read committed": 1, "repeatable read": 2, serializable: 3 };

type RepositoryContext = { db: RepositoryDatabase; requireTransaction(options?: TransactionOptions): Transaction };
export function defineRepository<T extends object>(factory: (context: RepositoryContext) => T): Definition<Eager<T>>;
export function defineRepository<D extends Dependencies, T extends object>(
  dependencies: D,
  factory: (context: Resolved<D> & RepositoryContext) => T,
): Definition<Eager<T>>;
export function defineRepository(
  dependencies: Dependencies | ((context: any) => object),
  factory?: (context: any) => object,
): Definition<object> {
  const declared = typeof dependencies === "function" ? {} : { ...dependencies };
  const build = typeof dependencies === "function" ? dependencies : factory;
  if (!build || "db" in declared || "requireTransaction" in declared) throw new Error("Invalid repository definition");
  return {
    [definition]: (scope) =>
      build(
        Object.assign(scope.resolve(declared), {
          db: scope.database(),
          requireTransaction: (options?: TransactionOptions) => scope.requireTransaction(options),
        }),
      ),
  };
}

export function defineService<D extends Dependencies, T extends object>(
  dependencies: D,
  factory: (
    context: Resolved<D> & {
      transaction: ServiceTransaction<Resolved<D>>;
    },
  ) => T,
): Definition<Eager<T>> {
  const declared = { ...dependencies };
  return {
    [definition]: (scope) =>
      factory(
        Object.assign(scope.resolve(declared), {
          transaction: scope.serviceTransaction(declared),
        }),
      ) as Eager<T>,
  };
}

export function createScope(db: Database): Scope {
  return new Scope(db);
}

export class Scope {
  private readonly cache = new Map<Definition<object>, object>();
  private readonly building = new Set<Definition<object>>();

  constructor(
    private readonly db: Database,
    private readonly state?: TransactionState,
  ) {}

  private assertActive() {
    if (this.state?.closed) throw new ScopeError("TRANSACTION_CLOSED");
    if (this.state?.failed) throw new ScopeError("TRANSACTION_ROLLBACK_ONLY", { cause: this.state.cause });
  }

  private fail(cause: unknown) {
    if (this.state && !this.state.failed) {
      this.state.failed = true;
      this.state.cause = cause;
    }
  }

  requireTransaction(options?: TransactionOptions): Transaction {
    this.assertActive();
    if (!this.state) throw new ScopeError("TRANSACTION_REQUIRED");
    try {
      this.checkOptions(options);
    } catch (error) {
      this.fail(error);
      throw error;
    }
    return this.state.tx;
  }

  tx(transaction: Transaction): Scope {
    this.assertActive();
    const target = transactions.get(transaction);
    if (!target || target.db !== this.db || (this.state && target !== this))
      throw new ScopeError("TRANSACTION_CONTEXT_MISMATCH");
    target.assertActive();
    return target;
  }

  get<T extends object>(source: Definition<T>): Scoped<T> {
    this.assertActive();
    const prior = this.cache.get(source);
    if (prior) return prior as Scoped<T>;
    if (this.building.has(source)) throw new ScopeError("CIRCULAR_DEPENDENCY");
    this.building.add(source);
    try {
      const value = source[definition](this);
      if ("tx" in value) throw new Error("tx is reserved for scoped bindings");
      // Decorate a fresh factory result, preserving class prototypes/private fields.
      const names = new Set<PropertyKey>();
      for (
        let prototype: object | null = value;
        prototype && prototype !== Object.prototype;
        prototype = Object.getPrototypeOf(prototype)
      ) {
        for (const key of Reflect.ownKeys(prototype)) {
          if (key === "constructor" || names.has(key)) continue;
          names.add(key);
          const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
          if (typeof descriptor?.value !== "function") continue;
          const method = descriptor.value as (...args: unknown[]) => unknown;
          Object.defineProperty(value, key, {
            configurable: true,
            enumerable: descriptor.enumerable ?? false,
            value: (...args: unknown[]) => {
              this.assertActive();
              try {
                const result = method.apply(value, args);
                if (result && typeof (result as PromiseLike<unknown>).then === "function") {
                  return Promise.resolve(result).catch((error: unknown) => {
                    this.fail(error);
                    throw error;
                  });
                }
                return result;
              } catch (error) {
                this.fail(error);
                throw error;
              }
            },
          });
        }
      }
      Object.defineProperty(value, "tx", { value: (tx: Transaction) => this.tx(tx).get(source) });
      instances.set(value, { scope: this, source });
      this.cache.set(source, value);
      return value as Scoped<T>;
    } finally {
      this.building.delete(source);
    }
  }

  resolve<D extends Dependencies>(dependencies: D): Resolved<D> {
    this.assertActive();
    const result: Dependencies = {};
    for (const [key, dependency] of Object.entries(dependencies)) {
      if (key === "transaction" || key === "uow") throw new Error(`${key} is reserved for scoped services`);
      if (dependency && typeof dependency === "object" && definition in dependency) {
        result[key] = this.get(dependency as Definition<object>);
      } else {
        const binding = dependency && typeof dependency === "object" ? instances.get(dependency) : undefined;
        if (binding) {
          binding.scope.assertActive();
          if (binding.scope.db !== this.db || (binding.scope.state && binding.scope !== this))
            throw new ScopeError("TRANSACTION_CONTEXT_MISMATCH");
          result[key] = this.get(binding.source);
        } else result[key] = dependency;
      }
    }
    return result as Resolved<D>;
  }

  private checkOptions(options?: TransactionOptions) {
    if (!options || !this.state) return;
    const current = this.state.options;
    if (
      (options.isolationLevel &&
        isolation[options.isolationLevel] > isolation[current.isolationLevel ?? "read committed"]) ||
      (current.accessMode === "read only" && options.accessMode === "read write") ||
      (options.deferrable && !current.deferrable)
    )
      throw new ScopeError("TRANSACTION_OPTIONS_MISMATCH");
  }

  async transaction<R>(operation: (scope: Scope) => Promise<R>, options?: TransactionOptions): Promise<R> {
    this.assertActive();
    if (this.state) {
      try {
        this.checkOptions(options);
        const result = await operation(this);
        this.assertActive();
        return result;
      } catch (error) {
        this.fail(error);
        throw error;
      }
    }
    return this.db.transaction(
      async (tx) => {
        const state: TransactionState = {
          tx,
          options: { isolationLevel: "read committed", ...options },
          closed: false,
          failed: false,
        };
        const child = new Scope(this.db, state);
        transactions.set(tx, child);
        try {
          const result = await operation(child);
          child.assertActive();
          return result;
        } finally {
          state.closed = true;
        }
      },
      { isolationLevel: "read committed", ...options },
    );
  }

  unitOfWork(): UnitOfWork {
    return {
      transaction: (operation, options) => this.transaction((scope) => operation(scope.requireTransaction()), options),
    };
  }

  serviceTransaction<D extends Dependencies>(dependencies: D): ServiceTransaction<Resolved<D>> {
    const declared = { ...dependencies };
    return (operation, options) => this.transaction((scope) => operation(scope.resolve(declared)), options);
  }

  /** Persistence adapter only. Service factories receive dependencies and UnitOfWork. */
  database(): RepositoryDatabase {
    const facade = {} as RepositoryDatabase;
    for (const name of ["select", "insert", "update", "delete", "execute"] as const) {
      Object.defineProperty(facade, name, {
        value: (...args: unknown[]) => {
          this.assertActive();
          const executor = this.state?.tx ?? this.db;
          return Reflect.apply(executor[name], executor, args);
        },
      });
    }
    return facade;
  }
}
