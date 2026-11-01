import test from "node:test";
import assert from "node:assert/strict";
import { compilePlugins } from "../src/kernel/graph.js";
import { install } from "../src/kernel/install.js";
import { Scope } from "../src/kernel/scope.js";
import { Registry } from "../src/kernel/registry.js";
import { ResourceAdmission } from "../src/kernel/admission.js";
import { Context } from "../src/kernel/context.js";
import type {
  PluginDefinition,
  CapabilityKey,
} from "../src/contracts/plugin.js";
const key: CapabilityKey<string> = { id: "test.value", version: 1 };
function plugin(
  id: string,
  requires: string[] = [],
  provides: string[] = [],
): PluginDefinition {
  return {
    manifest: {
      id,
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires,
      provides,
    },
    setup() {},
  };
}
test("plugin graph rejects missing, conflicting, cyclic and shorter-lived dependencies", () => {
  assert.throws(() => compilePlugins([plugin("a", ["absent"])], new Map()), {
    code: "MISSING_DEPENDENCY",
  });
  assert.throws(
    () =>
      compilePlugins(
        [plugin("a", [], ["x"]), plugin("b", [], ["x"])],
        new Map(),
      ),
    { code: "CAPABILITY_CONFLICT" },
  );
  assert.throws(
    () =>
      compilePlugins(
        [plugin("a", ["y"], ["x"]), plugin("b", ["x"], ["y"])],
        new Map(),
      ),
    { code: "PLUGIN_CYCLE" },
  );
  const session = plugin("session", [], ["x"]);
  const scoped = {
    ...session,
    manifest: { ...session.manifest, scope: "session" as const },
  };
  assert.throws(
    () => compilePlugins([scoped, plugin("root", ["x"])], new Map()),
    { code: "SCOPE_MISMATCH" },
  );
  assert.deepEqual(
    compilePlugins([plugin("z"), plugin("a")], new Map()).ordered.map(
      (p) => p.manifest.id,
    ),
    ["a", "z"],
  );
});
test("setup failure rolls back failing plugin resources and earlier registrations in reverse order", async () => {
  const calls: string[] = [];
  const first = plugin("first", [], [key.id]);
  first.setup = (ctx) => {
    ctx.provide(key, "value");
    ctx.onDispose(() => {
      calls.push("first");
    });
  };
  const second = plugin("second", [key.id]);
  second.setup = (ctx) => {
    assert.equal(ctx.resolve(key), "value");
    ctx.onDispose(() => {
      calls.push("second");
    });
    throw new Error("setup failed");
  };
  const scope = new Scope();
  const registry = new Registry();
  await assert.rejects(
    install([first, second], "kernel", scope, registry),
    /setup failed/,
  );
  assert.deepEqual(calls, ["second", "first"]);
  assert.throws(() => registry.resolve(key), {
    code: "CAPABILITY_UNAVAILABLE",
  });
  assert.strictEqual(scope.dispose(), scope.dispose());
});
test("resource admission is atomic, cancellation removes waiters and release is idempotent", async () => {
  const admission = new ResourceAdmission();
  const claims = [{ key: "runs", units: 1, limit: 1 }];
  const lease = admission.tryAcquire(claims);
  assert.ok(lease);
  assert.equal(
    admission.tryAcquire([...claims, { key: "file", units: 1, limit: 1 }]),
    undefined,
  );
  assert.deepEqual(admission.snapshot(), { runs: 1 });
  const controller = new AbortController();
  const waiting = admission.acquire(claims, controller.signal);
  controller.abort();
  await assert.rejects(waiting);
  lease.release();
  lease.release();
  assert.deepEqual(admission.snapshot(), {});
  assert.equal(admission.owns(lease, claims), false);
});

test("Context installs plugins by dependency order and passes explicit options", async () => {
  const value: CapabilityKey<string> = { id: "context.value", version: 1 };
  const calls: string[] = [];
  const provider: PluginDefinition<{ value: string }> = {
    manifest: {
      id: "context.provider",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [],
      provides: [value],
    },
    setup(context, options) {
      context.provide(value, options.value);
      context.onDispose(() => {
        calls.push("provider");
      });
    },
  };
  const consumer: PluginDefinition = {
    manifest: {
      id: "context.consumer",
      version: "1.0.0",
      apiVersion: 1,
      scope: "kernel",
      requires: [value],
      provides: [],
    },
    setup(context) {
      assert.equal(context.resolve(value), "configured");
      context.onDispose(() => {
        calls.push("consumer");
      });
    },
  };
  const context = new Context("kernel", {});
  await context.plugin(provider, { value: "configured" });
  await context.plugin(consumer);
  await context.ready();
  assert.equal(context.resolve(value), "configured");
  await context.dispose();
  assert.deepEqual(calls, ["consumer", "provider"]);
});
