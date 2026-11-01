import type { CapabilityKey, ContributionKey, Plugin, PluginContext, ScopeKind } from "./plugin.js";

export interface PluginRegistration {
  readonly plugin: Plugin;
  readonly options?: unknown;
}

/** The runtime container and lifecycle boundary used to install plugins. */
export interface Context extends PluginContext {
  readonly kind: ScopeKind;
  plugin<Options>(plugin: Plugin<Options>, options?: Options): Promise<void>;
  ready(): Promise<void>;
  fork(kind?: ScopeKind): Context;
  abort(reason?: unknown): void;
  dispose(): Promise<void>;
}

export type { CapabilityKey, ContributionKey, Plugin, PluginContext };
