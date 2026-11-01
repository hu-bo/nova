import { posix } from "node:path";
import type { RunnerRepository } from "./runner.repository.js";
import { DomainError } from "../../shared/domain-error.js";
import { runnerReadContext, type RunnerConnections } from "./runner-connections.js";

export class RunnerService {
  constructor(
    private readonly repository: RunnerRepository,
    private readonly connections: RunnerConnections,
  ) {}
  list(ownerUserId: string) {
    return this.repository.list(ownerUserId);
  }
  async listFiles(input: { ownerUserId: string; runnerId: string; path: string }) {
    const { session, runner } = await this.connections.require(input.runnerId, input.ownerUserId);
    if (!runner.workspaceId) throw new DomainError("CONFLICT", "Runner has no workspace");
    const path = normalize(input.path),
      context = runnerReadContext(session, runner.workspaceId);
    const result = await context.fs.list(path, { depth: 1, maxEntries: 500 });
    if (!result.ok)
      throw new DomainError("CONFLICT", "Could not read the Runner directory", { reason: result.error.code });
    return {
      root: runner.workspaceId,
      path,
      parent: path === "." ? null : posix.dirname(path),
      entries: result.value
        .filter((entry) => entry.kind !== "symlink")
        .map((entry) => ({
          name: posix.basename(entry.path.replaceAll("\\", "/")),
          path: entry.path.replaceAll("\\", "/"),
          kind: entry.kind === "dir" ? ("directory" as const) : ("file" as const),
        })),
    };
  }
  async summary(input: { ownerUserId: string; runnerId: string; paths: string[] }) {
    const { session, runner } = await this.connections.require(input.runnerId, input.ownerUserId);
    if (!runner.workspaceId) throw new DomainError("CONFLICT", "Runner has no workspace");
    const context = runnerReadContext(session, runner.workspaceId),
      items = [];
    for (const value of input.paths) {
      const path = normalize(value),
        result = await context.fs.read(path, { limit: 1 });
      if (!result.ok)
        throw new DomainError("CONFLICT", "Could not inspect the Runner file", { reason: result.error.code });
      items.push({ path, sha256: result.value.sha256, size: result.value.totalSize, mtime: new Date().toISOString() });
    }
    return items;
  }
}
function normalize(value: string) {
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").includes("..") || /[\x00-\x1f]/.test(path))
    throw new DomainError("VALIDATION_ERROR", "Invalid workspace path");
  return posix.normalize(path || ".");
}
