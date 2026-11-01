export interface ResourceClaim {
  readonly key: string;
  readonly units: number;
  readonly limit: number;
}
export interface AdmissionLease {
  readonly claims: readonly ResourceClaim[];
  readonly released: boolean;
  release(): void;
}
export interface Admission {
  tryAcquire(claims: readonly ResourceClaim[]): AdmissionLease | undefined;
  acquire(claims: readonly ResourceClaim[], signal: AbortSignal): Promise<AdmissionLease>;
  owns(lease: AdmissionLease, claims: readonly ResourceClaim[]): boolean;
  subscribe(listener: () => void): () => void;
  snapshot(): Readonly<Record<string, number>>;
}
export interface ManagedScope {
  readonly signal: AbortSignal;
  fork(): ManagedScope;
  onDispose(cleanup: () => void | Promise<void>): void;
  abort(reason?: unknown): void;
  dispose(): Promise<void>;
}
