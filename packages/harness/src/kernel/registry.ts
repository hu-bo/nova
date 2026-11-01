import type { CapabilityKey, ContributionKey } from "../contracts/plugin.js";
import { FrameworkError } from "../contracts/errors.js";
interface Entry {
  version: number;
  value: unknown;
}
export class Registry {
  private readonly values = new Map<string, Entry>();
  private readonly contributions = new Map<string, { version: number; values: unknown[] }>();
  private frozen = false;
  constructor(private readonly parent?: Registry) {}
  freeze(): void {
    this.frozen = true;
  }
  provide<T>(key: CapabilityKey<T>, value: T): void {
    if (this.frozen) throw new FrameworkError("REGISTRY_FROZEN", "Registrations are frozen.");
    if (this.find(key.id)) throw new FrameworkError("CAPABILITY_CONFLICT", "Duplicate capability: " + key.id);
    this.values.set(key.id, { version: key.version, value });
  }
  resolve<T>(key: CapabilityKey<T>): T {
    const entry = this.find(key.id);
    if (!entry || entry.version !== key.version)
      throw new FrameworkError("CAPABILITY_UNAVAILABLE", "Capability unavailable: " + key.id);
    // Heterogeneous storage erases T. Only provide<T> writes entries; manifest/version checks guard this boundary.
    return entry.value as T;
  }
  optional<T>(key: CapabilityKey<T>): T | undefined {
    if (!this.find(key.id)) return undefined;
    return this.resolve(key);
  }
  has<T>(key: CapabilityKey<T>): boolean {
    const entry = this.find(key.id);
    return entry !== undefined && entry.version === key.version;
  }
  hasLocal(id: string): boolean {
    return this.values.has(id);
  }
  add<T>(key: ContributionKey<T>, value: T): void {
    if (this.frozen) throw new FrameworkError("REGISTRY_FROZEN", "Registrations are frozen.");
    const existing = this.contributions.get(key.id);
    if (existing && existing.version !== key.version)
      throw new FrameworkError("VERSION_MISMATCH", "Contribution version mismatch.");
    if (existing) existing.values.push(value);
    else this.contributions.set(key.id, { version: key.version, values: [value] });
  }
  collect<T>(key: ContributionKey<T>): readonly T[] {
    const entry = this.contributions.get(key.id);
    if (entry && entry.version !== key.version)
      throw new FrameworkError("VERSION_MISMATCH", "Contribution version mismatch.");
    // Same typed registration boundary as resolve; callers receive a new readonly collection.
    return Object.freeze([...(this.parent?.collect(key) ?? []), ...(entry?.values ?? [])]) as readonly T[];
  }
  clear(): void {
    this.values.clear();
    this.contributions.clear();
  }
  private find(id: string): Entry | undefined {
    return this.values.get(id) ?? this.parent?.find(id);
  }
}
