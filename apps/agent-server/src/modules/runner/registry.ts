import path from "node:path";
import type { RunnerSession } from "@nova/runner-sdk";
import type { Project, RunnerDirectory, RunnerEvent } from "@nova/protocol";
import { AppError, invalidInput, runnerUnavailable } from "../../errors.js";
import type { AgentStore } from "../../store.js";
import { createLogger } from "@nova/logger";

const logger = createLogger("agent-server").child("runner-registry");

export type RunnerState = Project["runnerState"];

export interface RunnerRegistry {
  register(ownerId: string, tokenId: string, session: RunnerSession): Promise<void>;
  markDisconnected(ownerId: string, runnerId: string): void;
  state(userId: string, runnerId: string | null, workspace: string | null): RunnerState;
  status(userId: string, runnerId: string): RunnerState;
  isOnline(userId: string, runnerId: string): boolean;
  pick(userId: string, runnerId: string, workspace?: string): RunnerSession;
  verifyWorkspace(userId: string, runnerId: string, workspace: string): Promise<void>;
  listDirectories(userId: string, runnerId: string, requestedPath?: string): Promise<RunnerDirectory>;
  readFile(
    userId: string,
    runnerId: string,
    requestedPath: string,
    maxSize: number,
  ): Promise<{ name: string; size: number; data: Uint8Array }>;
  subscribe(userId: string, listener: (event: RunnerEvent) => void): () => void;
}

type Registered = {
  ownerId: string;
  tokenId: string;
  session: RunnerSession;
  unsubscribe: () => void;
  lastEvent: string;
};

export function createRunnerRegistry(store?: AgentStore, heartbeatIntervalMs = 5_000): RunnerRegistry {
  const sessions = new Map<string, Registered>();
  const listeners = new Map<string, Set<(event: RunnerEvent) => void>>();

  const current = (userId: string, runnerId: string): Registered | null => {
    const registered = sessions.get(key(userId, runnerId));
    return registered?.ownerId === userId ? registered : null;
  };

  const status = (userId: string, runnerId: string): RunnerState => {
    const registered = current(userId, runnerId);
    if (
      !registered?.session.lastHeartbeatAt ||
      Date.now() - registered.session.lastHeartbeatAt > heartbeatIntervalMs * 3
    ) {
      return "disconnected";
    }
    return reportedState(registered.session.state as number);
  };

  const available = (userId: string, runnerId: string, workspace?: string): Registered | null => {
    const registered = current(userId, runnerId);
    if (!registered || status(userId, runnerId) === "disconnected") return null;
    if (workspace && !withinRoot(registered.session.identity.workspace, workspace)) return null;
    return registered;
  };

  const publish = (userId: string, runnerId: string, state: RunnerState) => {
    const event: RunnerEvent = { type: "runner.changed", runnerId, state };
    for (const listener of listeners.get(userId) ?? []) listener(event);
  };

  const update = (registered: Registered) => {
    const runnerId = registered.session.identity.runnerId;
    const state = status(registered.ownerId, runnerId);
    const eventSignature = `${state}:${registered.session.running}`;
    if (registered.lastEvent !== eventSignature) {
      const previousState = registered.lastEvent.split(":", 1)[0] || "unregistered";
      registered.lastEvent = eventSignature;
      logger.info(
        {
          component: "server",
          dependency: "runner",
          runnerId,
          generation: registered.session.generation,
          previousState,
          state,
          running: registered.session.running,
        },
        "runner state changed",
      );
      publish(registered.ownerId, runnerId, state);
    }
    if (!registered.session.connected) {
      sessions.delete(key(registered.ownerId, runnerId));
      return;
    }
    void store?.updateRunnerStatus({
      ownerId: registered.ownerId,
      id: runnerId,
      running: registered.session.running,
      reportedState: state === "disconnected" ? null : state,
      lastSeenAt: new Date(),
    });
  };

  return {
    async register(ownerId, tokenId, session) {
      const runnerId = session.identity.runnerId;
      const sessionKey = key(ownerId, runnerId);
      const previous = sessions.get(sessionKey);
      const registered: Registered = { ownerId, tokenId, session, unsubscribe: () => {}, lastEvent: "" };
      registered.unsubscribe = session.onStatus(() => update(registered));
      sessions.set(sessionKey, registered);
      try {
        await store?.upsertRunner({
          id: runnerId,
          ownerId,
          tokenId,
          generation: session.generation,
          rootWorkspace: session.identity.workspace,
          version: session.identity.version,
          platform: session.identity.platform,
          capabilities: session.identity.capabilities,
          labels: session.identity.labels,
          maxConcurrency: session.identity.maxConcurrency,
          running: session.running,
          reportedState: null,
        });
      } catch (error) {
        logger.error(
          { err: error, component: "server", dependency: "runner", runnerId },
          "failed to persist runner registration",
        );
        registered.unsubscribe();
        if (sessions.get(sessionKey) === registered) sessions.delete(sessionKey);
        await session.close();
        throw error;
      }
      if (previous) {
        previous.unsubscribe();
        await previous.session.close();
      }
      logger.info(
        {
          component: "server",
          dependency: "runner",
          runnerId,
          generation: session.generation,
          platform: session.identity.platform,
          workspace: session.identity.workspace,
        },
        "runner registration persisted",
      );
    },
    markDisconnected(ownerId, runnerId) {
      const registered = sessions.get(key(ownerId, runnerId));
      registered?.unsubscribe();
      sessions.delete(key(ownerId, runnerId));
      logger.info({ component: "server", dependency: "runner", runnerId }, "runner disconnected");
      publish(ownerId, runnerId, "disconnected");
    },
    state(userId, runnerId, workspace) {
      if (!runnerId || !workspace) return "disconnected";
      return available(userId, runnerId, workspace) ? status(userId, runnerId) : "disconnected";
    },
    status,
    isOnline(userId, runnerId) {
      return status(userId, runnerId) !== "disconnected";
    },
    pick(userId, runnerId, workspace) {
      const registered = available(userId, runnerId, workspace);
      if (!registered || status(userId, runnerId) !== "ready") throw runnerUnavailable();
      return registered.session;
    },
    async verifyWorkspace(userId, runnerId, workspace) {
      const registered = current(userId, runnerId);
      if (!registered || !withinRoot(registered.session.identity.workspace, workspace)) {
        throw runnerUnavailable("Runner cannot access the selected workspace");
      }
      const info = await registered.session.fs.stat(workspace);
      if ((info.kind as number) !== 2) throw runnerUnavailable("The selected workspace is not a directory");
    },
    async listDirectories(userId, runnerId, requestedPath) {
      const registered = current(userId, runnerId);
      if (!registered || status(userId, runnerId) === "disconnected") throw runnerUnavailable();
      const root = registered.session.identity.workspace;
      const flavor = pathFlavor(root);
      const selected = flavor.normalize(requestedPath ?? root);
      if (!withinRoot(root, selected)) throw runnerUnavailable("Runner cannot access the selected directory");
      try {
        const info = await registered.session.fs.stat(selected);
        if ((info.kind as number) !== 2) throw runnerUnavailable("The selected path is not a directory");
        const entries = await registered.session.fs.list(selected, 1);
        const explorerEntries = entries
          .filter((entry) => (entry.kind as number) === 1 || (entry.kind as number) === 2)
          .map((entry) => ({
            name: entry.name,
            path: flavor.join(selected, entry.name),
            kind: (entry.kind as number) === 2 ? ("directory" as const) : ("file" as const),
          }))
          .filter((entry) => withinRoot(root, entry.path))
          .sort(
            (left, right) =>
              Number(left.kind === "file") - Number(right.kind === "file") || left.name.localeCompare(right.name),
          );
        const normalizedRoot = flavor.normalize(root);
        const parentPath = flavor.dirname(selected);
        return {
          root: normalizedRoot,
          path: selected,
          parent: samePath(flavor, selected, normalizedRoot) ? null : parentPath,
          entries: explorerEntries,
        };
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.warn(
          { err: error, component: "server", dependency: "runner", runnerId, path: selected },
          "runner directory lookup failed",
        );
        throw runnerUnavailable("Unable to read directories from the selected runner");
      }
    },
    async readFile(userId, runnerId, requestedPath, maxSize) {
      const registered = current(userId, runnerId);
      if (!registered || status(userId, runnerId) === "disconnected") throw runnerUnavailable();
      const root = registered.session.identity.workspace;
      const flavor = pathFlavor(root);
      const selected = flavor.normalize(requestedPath);
      if (!withinRoot(root, selected)) throw runnerUnavailable("Runner cannot access the selected file");
      try {
        const info = await registered.session.fs.stat(selected);
        if ((info.kind as number) !== 1) throw invalidInput("The selected path is not a file");
        const declaredSize = Number(info.size);
        if (!Number.isSafeInteger(declaredSize) || declaredSize < 0 || declaredSize > maxSize) {
          throw invalidInput(`The selected file exceeds the ${formatBytes(maxSize)} limit`);
        }
        const result = await registered.session.fs.readFile(selected, { limit: maxSize + 1 });
        if (result.totalSize > maxSize || result.data.byteLength > maxSize) {
          throw invalidInput(`The selected file exceeds the ${formatBytes(maxSize)} limit`);
        }
        return { name: flavor.basename(selected), size: result.data.byteLength, data: result.data };
      } catch (error) {
        if (error instanceof AppError) throw error;
        logger.warn(
          { err: error, component: "server", dependency: "runner", runnerId, path: selected },
          "runner file read failed",
        );
        throw runnerUnavailable("Unable to read the selected file from the runner");
      }
    },
    subscribe(userId, listener) {
      const owned = listeners.get(userId) ?? new Set();
      owned.add(listener);
      listeners.set(userId, owned);
      return () => {
        owned.delete(listener);
        if (!owned.size) listeners.delete(userId);
      };
    },
  };
}

function reportedState(state: number): RunnerState {
  switch (state) {
    case 1:
      return "ready";
    case 2:
      return "busy";
    case 3:
      return "draining";
    default:
      return "disconnected";
  }
}

function key(userId: string, runnerId: string): string {
  return `${userId}\0${runnerId}`;
}

function withinRoot(root: string, candidate: string): boolean {
  const flavor = pathFlavor(root);
  const normalizedRoot = flavor.resolve(root);
  const normalizedCandidate = flavor.resolve(candidate);
  if (flavor === path.win32) {
    return (
      normalizedCandidate.toLowerCase() === normalizedRoot.toLowerCase() ||
      normalizedCandidate.toLowerCase().startsWith(`${normalizedRoot.toLowerCase()}${flavor.sep}`)
    );
  }
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${flavor.sep}`);
}

function pathFlavor(root: string): typeof path.win32 | typeof path.posix {
  return /^[A-Za-z]:[\\/]/.test(root) || root.includes("\\") ? path.win32 : path.posix;
}

function samePath(flavor: typeof path.win32 | typeof path.posix, left: string, right: string): boolean {
  return flavor === path.win32 ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function formatBytes(bytes: number): string {
  return bytes % (1024 * 1024) === 0 ? `${bytes / (1024 * 1024)} MiB` : `${bytes} byte`;
}
