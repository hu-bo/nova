import type {
  CapabilityKey,
  CapabilityReference,
  ContributionKey,
  Plugin,
  PluginContext,
  PluginInspection,
  ScopeKind,
} from "../contracts/plugin.js";
import type { Context as ContextContract, PluginRegistration } from "../contracts/runtime.js";
import { FrameworkError } from "../contracts/errors.js";
import { compilePlugins, reference } from "./graph.js";
import { Registry } from "./registry.js";
import { Scope } from "./scope.js";

interface ContextOptions {
  readonly builtins?: ReadonlyMap<string, ScopeKind>;
  readonly scope?: Scope;
  readonly registry?: Registry;
}

export class Context implements ContextContract {
  private readonly scope: Scope;
  private readonly registry: Registry;
  private readonly builtins: ReadonlyMap<string, ScopeKind>;
  private readonly readyCallbacks: Array<() => void | Promise<void>> = [];
  private readonly pending = new Map<string, PluginRegistration>();
  private ordered: readonly PluginRegistration[] = [];
  private inspection: readonly PluginInspection[] = [];
  private closing?: Promise<void>;
  private sealed = false;
  private frozen = false;

  constructor(
    readonly kind: ScopeKind,
    options: ContextOptions = {},
  ) {
    this.scope = options.scope ?? new Scope();
    this.registry = options.registry ?? new Registry();
    this.builtins = options.builtins ?? new Map();
    this.scope.onDispose(() => this.registry.clear());
  }

  get signal(): AbortSignal {
    return this.scope.signal;
  }
  abort(reason?: unknown): void {
    this.scope.abort(reason);
  }

  fork(kind: ScopeKind = this.kind): Context {
    return new Context(kind, {
      builtins: this.builtins,
      scope: this.scope.fork(),
      registry: new Registry(this.registry),
    });
  }

  async plugin<Options>(plugin: Plugin<Options>, suppliedOptions?: Options): Promise<void> {
    if (this.sealed || this.closing) throw new FrameworkError("CLOSED", "Context is already ready or closing.");
    const manifest = plugin.manifest;
    if (
      !manifest ||
      manifest.apiVersion !== 1 ||
      !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(manifest.id) ||
      !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)
    )
      throw new FrameworkError("INVALID_CONFIG", "Invalid plugin manifest.");
    if (this.pending.has(manifest.id)) throw new FrameworkError("DUPLICATE_PLUGIN", "Duplicate plugin: " + manifest.id);
    const options = suppliedOptions === undefined ? (plugin.config as Options) : suppliedOptions;
    try {
      plugin.configSchema?.parse(options);
    } catch {
      throw new FrameworkError("INVALID_CONFIG", "Invalid plugin configuration: " + manifest.id);
    }
    this.pending.set(manifest.id, { plugin, options });
  }

  private async setup(registration: PluginRegistration): Promise<void> {
    const { plugin, options } = registration;
    const manifest = plugin.manifest;
    const instance = this.scope.fork();
    const check = (key: CapabilityKey<unknown>, allowed: readonly CapabilityReference[]) => {
      if (
        !allowed.some((item) => {
          const value = reference(item);
          return value.id === key.id && value.version === key.version;
        })
      )
        throw new FrameworkError("UNDECLARED_CAPABILITY", manifest.id + " did not declare " + key.id);
    };
    try {
      const context: PluginContext = {
        signal: instance.signal,
        resolve: (key) => {
          check(key, manifest.requires);
          return this.registry.resolve(key);
        },
        optional: (key) => {
          check(key, [...manifest.requires, ...(manifest.optional ?? [])]);
          return this.registry.optional(key);
        },
        collect: (key) => {
          check(key, [...manifest.requires, ...(manifest.optional ?? []), ...(manifest.contributes ?? [])]);
          return this.registry.collect(key);
        },
        provide: (key, value) => {
          check(key, manifest.provides);
          this.registry.provide(key, value);
        },
        contribute: (key, value) => {
          check(key, manifest.contributes ?? []);
          this.registry.add(key, value);
        },
        onDispose: (cleanup) => instance.onDispose(cleanup),
        onReady: (callback) => this.readyCallbacks.push(callback),
      };
      await plugin.setup(context, options);
      for (const item of manifest.provides) {
        const key = reference(item);
        if (!this.registry.hasLocal(key.id))
          throw new FrameworkError("MISSING_PROVIDER", manifest.id + " did not provide " + key.id);
      }
    } catch (error) {
      try {
        await this.dispose();
      } catch (cleanupError) {
        void cleanupError;
        process.emitWarning("Plugin setup failed and resource rollback reported an additional failure.", {
          code: "SETUP_ROLLBACK_FAILED",
        });
      }
      throw error;
    }
  }

  async install(plugins: readonly (Plugin | PluginRegistration)[]): Promise<void> {
    try {
      for (const item of plugins) {
        const registration = "plugin" in item ? item : { plugin: item };
        await this.plugin(registration.plugin, registration.options);
      }
      await this.ready();
    } catch (error) {
      try {
        await this.dispose();
      } catch {
        throw new FrameworkError("SETUP_ROLLBACK_FAILED", "Plugin setup and resource rollback failed.");
      }
      throw error;
    }
  }

  async ready(): Promise<void> {
    if (this.closing) throw new FrameworkError("CLOSED", "Context is closing.");
    if (this.sealed) return;
    this.sealed = true;
    try {
      const registrations = [...this.pending.values()];
      const definitions = registrations.map(({ plugin, options }) =>
        options === undefined ? plugin : { ...plugin, config: options },
      );
      const compiled = compilePlugins(definitions, this.builtins);
      const byId = new Map(registrations.map((registration) => [registration.plugin.manifest.id, registration]));
      this.ordered = compiled.ordered
        .map((plugin) => byId.get(plugin.manifest.id))
        .filter((registration): registration is PluginRegistration => registration !== undefined);
      this.inspection = structuredClone(compiled.inspection);
      for (const registration of this.ordered) {
        if (registration.plugin.manifest.scope === this.kind) await this.setup(registration);
      }
      // Ready callbacks can inspect the final contribution set, but cannot
      // mutate the installed graph after setup has completed.
      this.registry.freeze();
      this.frozen = true;
      for (const callback of this.readyCallbacks) await callback();
    } catch (error) {
      try {
        await this.dispose();
      } catch {
        throw new FrameworkError("SETUP_ROLLBACK_FAILED", "Plugin setup and resource rollback failed.");
      }
      throw error;
    }
  }

  get registrations(): readonly PluginRegistration[] {
    return this.ordered;
  }
  inspectPlugins(): readonly PluginInspection[] {
    return structuredClone(this.inspection);
  }

  resolve<T>(key: CapabilityKey<T>): T {
    return this.registry.resolve(key);
  }
  optional<T>(key: CapabilityKey<T>): T | undefined {
    return this.registry.optional(key);
  }
  collect<T>(key: ContributionKey<T>): readonly T[] {
    return this.registry.collect(key);
  }

  // These methods are intentionally available to the host Context. Plugins
  // receive the narrower PluginContext above and can only register declared values.
  provide<T>(key: CapabilityKey<T>, value: T): void {
    if (this.frozen) throw new FrameworkError("REGISTRY_FROZEN", "Registrations are frozen.");
    this.registry.provide(key, value);
  }
  contribute<T>(key: ContributionKey<T>, value: T): void {
    if (this.frozen) throw new FrameworkError("REGISTRY_FROZEN", "Registrations are frozen.");
    this.registry.add(key, value);
  }
  onDispose(cleanup: () => void | Promise<void>): void {
    this.scope.onDispose(cleanup);
  }
  onReady(callback: () => void | Promise<void>): void {
    if (this.sealed) throw new FrameworkError("CLOSED", "Context is already ready or closing.");
    this.readyCallbacks.push(callback);
  }

  dispose(): Promise<void> {
    this.closing ??= this.scope.dispose();
    return this.closing;
  }
}
