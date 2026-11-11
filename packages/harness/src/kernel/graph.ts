import { createHash } from "node:crypto";
import type { CapabilityReference, PluginDefinition, PluginInspection, ScopeKind } from "../contracts/plugin.js";
import { FrameworkError } from "../contracts/errors.js";
export function reference(value: CapabilityReference): {
  id: string;
  version: number;
} {
  let result: { id: string; version: number } | undefined;
  if (typeof value === "string") result = { id: value, version: 1 };
  else if (value && typeof value === "object") result = value;
  if (
    !result ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(result.id) ||
    !Number.isSafeInteger(result.version) ||
    result.version < 1
  )
    throw new FrameworkError("INVALID_CONFIG", "Invalid capability reference.");
  return result;
}
const rank: Record<ScopeKind, number> = { kernel: 0, session: 1, run: 2 };
function validateManifest(plugin: PluginDefinition): void {
  const manifest = plugin.manifest;
  if (
    !manifest ||
    manifest.apiVersion !== 1 ||
    !Object.hasOwn(rank, manifest.scope) ||
    !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(manifest.id) ||
    !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version) ||
    !isReferenceList(manifest.requires) ||
    !isReferenceList(manifest.provides) ||
    !isOptionalReferenceList(manifest.optional) ||
    !isOptionalReferenceList(manifest.contributes) ||
    !isOptionalStringList(manifest.before) ||
    !isOptionalStringList(manifest.after)
  )
    throw new FrameworkError("INVALID_CONFIG", "Invalid plugin manifest.");
  for (const value of [
    ...manifest.requires,
    ...(manifest.optional ?? []),
    ...manifest.provides,
    ...(manifest.contributes ?? []),
  ])
    reference(value);
  for (const pluginId of [...(manifest.before ?? []), ...(manifest.after ?? [])])
    if (typeof pluginId !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(pluginId))
      throw new FrameworkError("INVALID_CONFIG", "Invalid plugin ordering target.");
}

function isCapabilityReference(value: unknown): value is CapabilityReference {
  return (
    typeof value === "string" ||
    (typeof value === "object" &&
      value !== null &&
      "id" in value &&
      typeof value.id === "string" &&
      "version" in value &&
      typeof value.version === "number")
  );
}
function isReferenceList(value: unknown): value is readonly CapabilityReference[] {
  return Array.isArray(value) && value.every(isCapabilityReference);
}
function isOptionalReferenceList(value: unknown): value is readonly CapabilityReference[] | undefined {
  return value === undefined || isReferenceList(value);
}
function isOptionalStringList(value: unknown): value is readonly string[] | undefined {
  return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));
}
export interface CompiledPlugins {
  ordered: readonly PluginDefinition[];
  inspection: readonly PluginInspection[];
}
export function compilePlugins(
  plugins: readonly PluginDefinition[],
  builtins: ReadonlyMap<string, ScopeKind>,
): CompiledPlugins {
  const byId = new Map<string, PluginDefinition>();
  const providers = new Map<string, { plugin?: string; scope: ScopeKind; version: number }>();
  for (const [id, scope] of builtins) providers.set(id, { scope, version: 1 });
  for (const plugin of plugins) {
    const manifest = plugin.manifest;
    validateManifest(plugin);
    if (byId.has(manifest.id)) throw new FrameworkError("DUPLICATE_PLUGIN", "Duplicate plugin: " + manifest.id);
    byId.set(manifest.id, plugin);
    try {
      plugin.configSchema?.parse(plugin.config);
    } catch {
      throw new FrameworkError("INVALID_CONFIG", "Invalid plugin configuration: " + manifest.id);
    }
    for (const item of manifest.provides) {
      const key = reference(item);
      if (providers.has(key.id)) throw new FrameworkError("CAPABILITY_CONFLICT", "Duplicate capability: " + key.id);
      providers.set(key.id, {
        plugin: manifest.id,
        scope: manifest.scope,
        version: key.version,
      });
    }
  }
  const edges = new Map<string, Set<string>>([...byId.keys()].map((id) => [id, new Set()]));
  function depend(id: string, target: string): void {
    if (!byId.has(target)) throw new FrameworkError("UNKNOWN_PLUGIN", "Unknown ordering target: " + target);
    edges.get(id)?.add(target);
  }
  for (const plugin of plugins) {
    const m = plugin.manifest;
    for (const [required, values] of [
      [true, m.requires],
      [false, m.optional ?? []],
    ] as const) {
      for (const item of values) {
        const key = reference(item);
        const provider = providers.get(key.id);
        // Contributions are finalized after setup; they are not singleton dependency edges.
        const contributors = plugins.filter((p) => p.manifest.contributes?.some((c) => reference(c).id === key.id));
        if (!provider) {
          if (contributors.length) {
            if (
              contributors.some(
                (p) =>
                  rank[p.manifest.scope] > rank[m.scope] ||
                  p.manifest.contributes?.some(
                    (c) => reference(c).id === key.id && reference(c).version !== key.version,
                  ),
              )
            )
              throw new FrameworkError("SCOPE_MISMATCH", "Contribution dependency is incompatible: " + key.id);
            continue;
          }
          if (required) throw new FrameworkError("MISSING_DEPENDENCY", "Missing capability: " + key.id);
          continue;
        }
        if (provider.version !== key.version)
          throw new FrameworkError("VERSION_MISMATCH", "Incompatible capability: " + key.id);
        if (rank[provider.scope] > rank[m.scope])
          throw new FrameworkError("SCOPE_MISMATCH", "Longer-lived plugin cannot capture " + key.id);
        if (provider.plugin) depend(m.id, provider.plugin);
      }
    }
    for (const id of m.after ?? []) depend(m.id, id);
    for (const id of m.before ?? []) depend(id, m.id);
  }
  const ordered: PluginDefinition[] = [];
  const visiting: string[] = [];
  const done = new Set<string>();
  function visit(id: string): void {
    const cycle = visiting.indexOf(id);
    if (cycle >= 0) throw new FrameworkError("PLUGIN_CYCLE", [...visiting.slice(cycle), id].join(" -> "));
    if (done.has(id)) return;
    visiting.push(id);
    for (const parent of [...(edges.get(id) ?? [])].sort()) visit(parent);
    visiting.pop();
    done.add(id);
    const plugin = byId.get(id);
    if (plugin) ordered.push(plugin);
  }
  for (const id of [...byId.keys()].sort()) visit(id);
  const inspection = ordered.map(({ manifest: m, config }) => {
    const summary: Record<string, number | boolean | null> = {};
    if (config && typeof config === "object") {
      const entries: [string, unknown][] = Object.entries(config);
      for (const [key, value] of entries) {
        if (
          !/secret|token|key|password|credential/i.test(key) &&
          (typeof value === "number" || typeof value === "boolean" || value === null)
        )
          summary[key] = value;
      }
    }
    return {
      id: m.id,
      version: m.version,
      apiVersion: m.apiVersion,
      scope: m.scope,
      requires: structuredClone(m.requires),
      provides: structuredClone(m.provides),
      contributes: structuredClone(m.contributes ?? []),
      manifestHash: createHash("sha256").update(JSON.stringify(m)).digest("hex"),
      config: summary,
    };
  });
  return { ordered, inspection };
}
