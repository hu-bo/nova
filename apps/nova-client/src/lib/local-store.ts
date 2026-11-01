interface Expiring<T> {
  value: T;
  expiresAt: number;
}

/**
 * 源参考 `apps/agent-web-ui/src/lib/storage.ts` 中 `LocalStore<T>` 的等价实现。
 *
 * - 未设置 `ttlMs` 时按裸值存储，与历史数据保持兼容。
 * - `get()` 始终返回 fallback 而不是抛错，让配置变更可以无视存储异常继续运行。
 * - `set()` 在隐私模式或配额耗尽时静默降级。
 */
export class LocalStore<T> {
  constructor(
    private readonly key: string,
    private readonly fallback: T,
    private readonly ttlMs?: number,
  ) {}

  get(): T {
    try {
      const raw = localStorage.getItem(this.key);
      if (raw === null) return this.fallback;
      const parsed = JSON.parse(raw) as T | Expiring<T>;
      if (this.ttlMs === undefined) return parsed as T;
      const entry = parsed as Expiring<T>;
      if (typeof entry?.expiresAt !== 'number') return this.fallback;
      if (Date.now() >= entry.expiresAt) {
        this.clear();
        return this.fallback;
      }
      return entry.value;
    } catch {
      return this.fallback;
    }
  }

  set(value: T): void {
    try {
      const payload =
        this.ttlMs === undefined
          ? value
          : ({ value, expiresAt: Date.now() + this.ttlMs } satisfies Expiring<T>);
      localStorage.setItem(this.key, JSON.stringify(payload));
    } catch {
      // 隐私模式或配额耗尽时静默降级，不影响交互。
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(this.key);
    } catch {
      // 同上。
    }
  }
}
