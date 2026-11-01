import type { Admission, AdmissionLease, ResourceClaim } from "../contracts/admission.js";
import { FrameworkError } from "../contracts/errors.js";
import { positive } from "../shared/json.js";
export class ResourceAdmission implements Admission {
  private readonly used = new Map<string, number>();
  private readonly limits = new Map<string, number>();
  private readonly leases = new WeakSet<AdmissionLease>();
  private readonly listeners = new Set<() => void>();
  private waiters = 0;
  tryAcquire(input: readonly ResourceClaim[]): AdmissionLease | undefined {
    const grouped = new Map<string, ResourceClaim>();
    for (const claim of input) {
      positive(claim.units, "resource units");
      positive(claim.limit, "resource limit");
      if (!claim.key || claim.units > claim.limit)
        throw new FrameworkError("INVALID_RESOURCE", "Unsatisfiable resource claim.");
      const prior = grouped.get(claim.key);
      const limit = this.limits.get(claim.key);
      if ((limit !== undefined && limit !== claim.limit) || (prior && prior.limit !== claim.limit))
        throw new FrameworkError("INVALID_RESOURCE", "Resource capacity must be consistent: " + claim.key);
      grouped.set(claim.key, {
        ...claim,
        units: claim.units + (prior?.units ?? 0),
      });
    }
    const claims = [...grouped.values()];
    for (const claim of claims) {
      if (claim.units > claim.limit)
        throw new FrameworkError("INVALID_RESOURCE", "Combined resource claim exceeds capacity.");
      if ((this.used.get(claim.key) ?? 0) + claim.units > claim.limit) return undefined;
    }
    for (const claim of claims) {
      this.limits.set(claim.key, claim.limit);
      this.used.set(claim.key, (this.used.get(claim.key) ?? 0) + claim.units);
    }
    let released = false;
    const lease: AdmissionLease = {
      claims: Object.freeze(claims.map((claim) => Object.freeze(claim))),
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        for (const claim of claims) {
          const remaining = (this.used.get(claim.key) ?? 0) - claim.units;
          if (remaining) this.used.set(claim.key, remaining);
          else {
            this.used.delete(claim.key);
            this.limits.delete(claim.key);
          }
        }
        for (const listener of [...this.listeners]) {
          try {
            listener();
          } catch {
            process.emitWarning("Resource admission listener failed.", {
              code: "ADMISSION_LISTENER_FAILED",
            });
          }
        }
      },
    };
    this.leases.add(lease);
    return lease;
  }
  acquire(claims: readonly ResourceClaim[], signal: AbortSignal): Promise<AdmissionLease> {
    signal.throwIfAborted();
    const immediate = this.tryAcquire(claims);
    if (immediate) return Promise.resolve(immediate);
    if (this.waiters >= 10_000) throw new FrameworkError("CAPACITY", "Resource waiter capacity reached.");
    this.waiters++;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.listeners.delete(wake);
        signal.removeEventListener("abort", abort);
        this.waiters--;
      };
      const abort = () => {
        cleanup();
        const reason: unknown = signal.reason;
        reject(reason instanceof Error ? reason : new FrameworkError("CANCELLED", "Resource wait cancelled."));
      };
      const wake = () => {
        if (signal.aborted) {
          abort();
          return;
        }
        try {
          const lease = this.tryAcquire(claims);
          if (lease) {
            cleanup();
            resolve(lease);
          }
        } catch (error) {
          cleanup();
          reject(
            error instanceof Error ? error : new FrameworkError("INVALID_RESOURCE", "Resource acquisition failed."),
          );
        }
      };
      this.listeners.add(wake);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  owns(lease: AdmissionLease, claims: readonly ResourceClaim[]): boolean {
    if (!this.leases.has(lease) || lease.released) return false;
    const requested = new Map<string, ResourceClaim>();
    for (const claim of claims) {
      if (
        !claim.key ||
        !Number.isSafeInteger(claim.units) ||
        claim.units <= 0 ||
        !Number.isSafeInteger(claim.limit) ||
        claim.limit <= 0 ||
        claim.units > claim.limit
      )
        return false;
      const previous = requested.get(claim.key);
      if (previous && previous.limit !== claim.limit) return false;
      requested.set(claim.key, {
        ...claim,
        units: claim.units + (previous?.units ?? 0),
      });
    }
    return [...requested.values()].every((claim) =>
      lease.claims.some(
        (owned) => owned.key === claim.key && owned.units >= claim.units && owned.limit === claim.limit,
      ),
    );
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.used));
  }
}
