import type { Cleanup } from "../contracts/plugin.js";
import type { ManagedScope } from "../contracts/admission.js";
import { FrameworkError } from "../contracts/errors.js";
export class Scope implements ManagedScope {
  private readonly controller = new AbortController();
  private readonly children = new Set<Scope>();
  private readonly cleanups: Cleanup[] = [];
  private closing?: Promise<void>;
  constructor(private readonly parent?: Scope) {}
  get signal(): AbortSignal {
    return this.controller.signal;
  }
  fork(): Scope {
    if (this.closing || this.signal.aborted) throw new FrameworkError("CLOSED", "Scope is closing.");
    const child = new Scope(this);
    this.children.add(child);
    return child;
  }
  onDispose(cleanup: Cleanup): void {
    if (this.closing) throw new FrameworkError("CLOSED", "Cannot register cleanup while closing.");
    this.cleanups.push(cleanup);
  }
  abort(reason: unknown = new FrameworkError("CANCELLED", "Operation cancelled.")): void {
    try {
      this.controller.abort(reason);
    } catch {
      process.emitWarning("Scope abort listener failed.", {
        code: "SCOPE_ABORT_FAILED",
      });
    }
    for (const child of this.children) {
      try {
        child.abort(reason);
      } catch {
        process.emitWarning("Child scope abort listener failed.", {
          code: "SCOPE_ABORT_FAILED",
        });
      }
    }
  }
  dispose(): Promise<void> {
    this.closing ??= Promise.resolve().then(() => this.close());
    return this.closing;
  }
  private async close(): Promise<void> {
    this.abort();
    const failures: unknown[] = [];
    for (const child of [...this.children].reverse()) {
      try {
        await child.dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    this.cleanups.length = 0;
    this.parent?.children.delete(this);
    if (failures.length)
      throw new FrameworkError("CLEANUP_FAILED", failures.length + " resource cleanup operations failed.");
  }
}
