export type ScopeKind = "kernel" | "session" | "run";
export type Cleanup = () => void | Promise<void>;

export interface Schema<T> {
  parse(input: unknown): T;
}

export interface CapabilityKey<T> {
  readonly id: string;
  readonly version: number;
  readonly _type?: T;
}

export interface ContributionKey<T> extends CapabilityKey<T> {
  readonly collection: true;
}

export type CapabilityReference = string | { readonly id: string; readonly version: number };

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly scope: ScopeKind;
  readonly requires: readonly CapabilityReference[];
  readonly optional?: readonly CapabilityReference[];
  readonly provides: readonly CapabilityReference[];
  readonly contributes?: readonly CapabilityReference[];
  readonly before?: readonly string[];
  readonly after?: readonly string[];
}

export interface PluginContext {
  readonly signal: AbortSignal;
  resolve<T>(key: CapabilityKey<T>): T;
  optional<T>(key: CapabilityKey<T>): T | undefined;
  collect<T>(key: ContributionKey<T>): readonly T[];
  provide<T>(key: CapabilityKey<T>, value: T): void;
  contribute<T>(key: ContributionKey<T>, value: T): void;
  onDispose(cleanup: Cleanup): void;
  /** Runs after every setup in this scope, before callers can use it. */
  onReady(callback: () => void | Promise<void>): void;
}

export interface PluginDefinition<Options = unknown> {
  readonly manifest: PluginManifest;
  /** Legacy embedded options. Prefer passing options to Context.plugin. */
  readonly config?: Options;
  readonly configSchema?: Schema<Options>;
  setup(context: PluginContext, options: Options): void | Promise<void>;
}

/** A Plugin is a runtime capability boundary, not an npm package boundary. */
export type Plugin<Options = unknown> = PluginDefinition<Options>;

export interface PluginInspection {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: 1;
  readonly scope: ScopeKind;
  readonly requires: readonly CapabilityReference[];
  readonly provides: readonly CapabilityReference[];
  readonly contributes: readonly CapabilityReference[];
  readonly manifestHash: string;
  /** Only JSON-safe, non-secret metadata selected by the framework. */
  readonly config: Readonly<Record<string, string | number | boolean | null>>;
}
