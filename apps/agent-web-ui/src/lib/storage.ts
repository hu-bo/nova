interface Expiring<T> {
  value: T;
  expiresAt: number;
}

export class LocalStore<T> {
  // 未设置 ttlMs 时按裸值存储，保持与历史数据兼容
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
      if (typeof entry?.expiresAt !== "number") return this.fallback;
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
        this.ttlMs === undefined ? value : ({ value, expiresAt: Date.now() + this.ttlMs } satisfies Expiring<T>);
      localStorage.setItem(this.key, JSON.stringify(payload));
    } catch {
      // 隐私模式或配额耗尽时静默降级，不影响交互
    }
  }

  clear(): void {
    try {
      localStorage.removeItem(this.key);
    } catch {
      // 同上
    }
  }
}
