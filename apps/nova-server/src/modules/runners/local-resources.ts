import { randomUUID } from "node:crypto";
import type { ResourceCatalogPublished, RunnerSession } from "@nova/runner-sdk";
import type {
  AcceptedAgentCatalog,
  LocalCatalogEntry,
  LocalCatalogView,
  SkillCatalogDiagnostic,
  SkillCatalogStatus,
  SkillDirectoryPort,
} from "../skills/index.js";
import { DomainError } from "../../shared/domain-error.js";

/**
 * Runner 本地目录服务端视图（docs/nova-skills.md §4.3、P0-E1/E4）。
 * 目录版本与诊断存于认证连接态（§8.1：不进独立管理表）；技能条目的来源索引与
 * 不可变快照版本经 CatalogAcceptor 交给 skills 模块登记——两个 Runner 上的
 * 同名技能因此不是同一资源（§4.3 身份与覆盖）。
 */

export type CatalogAcceptInput = {
  ownerUserId: string;
  runnerRowId: string;
  entries: readonly LocalCatalogEntry[];
  readSnapshot: (entry: LocalCatalogEntry) => Promise<string>;
};
export type CatalogAcceptResult = { skills: Map<string, unknown>; agents: AcceptedAgentCatalog[] };
export type CatalogAcceptor = (input: CatalogAcceptInput) => Promise<CatalogAcceptResult>;

type StoredView = {
  ownerUserId: string;
  session: RunnerSession;
  revision: number;
  complete: boolean;
  stale: boolean;
  published: boolean;
  entries: readonly LocalCatalogEntry[];
  agents: AcceptedAgentCatalog[];
  diagnostics: SkillCatalogDiagnostic[];
  acceptChain: Promise<unknown>;
};

type PendingRefresh = { settle: (view: LocalCatalogView) => void; timer: NodeJS.Timeout };

const REFRESH_WAIT_MS = 30_000;

export class RunnerLocalResources {
  private readonly views = new Map<string, StoredView>();
  private readonly pendingRefreshes = new Map<string, PendingRefresh>();
  private acceptor: CatalogAcceptor = async () => ({ skills: new Map(), agents: [] });

  constructor(private readonly warn: (message: string, error: unknown) => void = () => undefined) {}

  /** skills 模块的目录接受回调（app 组装时注入，避免模块间构造环）。 */
  setCatalogAcceptor(acceptor: CatalogAcceptor): void {
    this.acceptor = acceptor;
  }

  /** 在已认证 Runner session 上接入目录监听；重连（新 session）自动替换旧视图并重新发布。 */
  attach(runnerRowId: string, ownerUserId: string, session: RunnerSession): void {
    const view: StoredView = {
      ownerUserId,
      session,
      revision: 0,
      complete: false,
      stale: false,
      published: false,
      entries: [],
      agents: [],
      diagnostics: [],
      acceptChain: Promise.resolve(),
    };
    this.views.set(runnerRowId, view);
    session.onResourceCatalog((catalog) => {
      void this.publish(runnerRowId, view, catalog).catch((error) => this.warn("local resource catalog ingest failed", error));
    });
  }

  private async publish(runnerRowId: string, view: StoredView, catalog: ResourceCatalogPublished): Promise<void> {
    if (this.views.get(runnerRowId) !== view) return; // 已被新 session 替换
    view.revision = Number(catalog.catalogRevision);
    view.complete = catalog.complete;
    view.published = true;
    view.stale = false;
    view.entries = catalog.entries;
    view.diagnostics = catalog.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.name ? { name: diagnostic.name } : {}),
      ...(diagnostic.path ? { path: diagnostic.path } : {}),
    })) as SkillCatalogDiagnostic[];
    // 快照接受串行执行；单条失败保留在条目级诊断，不影响连接与其它 RPC。
    const readSnapshot = (entry: LocalCatalogEntry) => this.readEntrySnapshot({ ownerUserId: view.ownerUserId, runnerRowId, entry });
    view.acceptChain = view.acceptChain
      .catch(() => undefined)
      .then(async () => {
        const result = await this.acceptor({ ownerUserId: view.ownerUserId, runnerRowId, entries: view.entries, readSnapshot });
        if (this.views.get(runnerRowId) === view) view.agents = result.agents;
      })
      .catch(() => undefined);
    if (catalog.refreshId) {
      const pending = this.pendingRefreshes.get(catalog.refreshId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRefreshes.delete(catalog.refreshId);
        pending.settle(this.snapshot(view));
      }
    }
  }

  /** 目录读取（skills 模块端口）：跨账号/跨 Runner 不串用（归属在视图上双重核对）。 */
  view(runnerRowId: string, ownerUserId: string): LocalCatalogView | undefined {
    const view = this.views.get(runnerRowId);
    if (!view || view.ownerUserId !== ownerUserId) return undefined;
    return this.snapshot(view);
  }

  private snapshot(view: StoredView): LocalCatalogView {
    return {
      online: view.session.connected,
      status: this.status(view),
      revision: view.revision,
      complete: view.complete,
      diagnostics: view.diagnostics,
      entries: view.entries,
      agents: view.agents,
      writable: view.session.connected && view.session.supportsLocalResourceWrites(),
    };
  }

  private status(view: StoredView): SkillCatalogStatus {
    if (!view.session.supportsLocalResources()) return "unsupported";
    if (!view.session.connected) return "offline";
    if (!view.published) return "scanning";
    if (view.stale) return "stale";
    if (!view.complete) return "incomplete";
    return "ready";
  }

  /** 定向刷新：校验归属与已注册 workspace 后下发；应答失败/超时保留旧目录并标过期。 */
  async refresh(input: {
    ownerUserId: string;
    runnerRowId: string;
    scope: "global" | "project";
    workspaceId?: string;
    relativeDir?: string;
  }): Promise<LocalCatalogView> {
    const view = this.views.get(input.runnerRowId);
    if (!view || view.ownerUserId !== input.ownerUserId) throw new DomainError("NOT_FOUND", "Runner directory is unavailable");
    if (!view.session.supportsLocalResources())
      throw new DomainError("CONFLICT", "Runner does not support local resource discovery", { reason: "RUNNER_UNSUPPORTED" });
    if (!view.session.connected) throw new DomainError("CONFLICT", "Runner is offline", { reason: "RUNNER_OFFLINE" });
    if (input.scope === "project") {
      const registered = view.session.workspaces.some((workspace) => workspace.workspaceId === input.workspaceId);
      if (!registered) throw new DomainError("VALIDATION_ERROR", "Workspace is not registered on this Runner");
    }
    const refreshId = randomUUID();
    const response = new Promise<LocalCatalogView>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRefreshes.delete(refreshId);
        view.stale = true; // 刷新失败保留旧目录并标过期（§4.3 时机与诊断）。
        reject(new DomainError("CONFLICT", "Local directory refresh did not complete; the previous catalog is marked stale"));
      }, REFRESH_WAIT_MS);
      this.pendingRefreshes.set(refreshId, { settle: resolve, timer });
    });
    const sent = await view.session.refreshResources({
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.relativeDir ? { relativeDir: input.relativeDir } : {}),
      refreshId,
    });
    if (!sent.ok) {
      const pending = this.pendingRefreshes.get(refreshId);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRefreshes.delete(refreshId);
      }
      view.stale = true;
      throw new DomainError("CONFLICT", `Local directory refresh failed: ${sent.error.message}`);
    }
    return response;
  }

  /** 快照读取：Runner 以 expectedSha256 做摘要核验，漂移即拒绝（不以新内容替代旧摘要）。 */
  async readEntrySnapshot(input: { ownerUserId: string; runnerRowId: string; entry: LocalCatalogEntry }): Promise<string> {
    const view = this.views.get(input.runnerRowId);
    if (!view || view.ownerUserId !== input.ownerUserId) throw new DomainError("NOT_FOUND", "Runner directory is unavailable");
    if (!view.session.connected) throw new DomainError("CONFLICT", "Runner is offline", { reason: "RUNNER_OFFLINE" });
    const result = await view.session.readResourceSnapshot({
      kind: input.entry.kind,
      scope: input.entry.scope,
      ...(input.entry.scope === "project" ? { workspaceId: input.entry.workspaceId } : {}),
      ...(input.entry.scope === "project" ? { relativeDir: input.entry.relativeDir } : {}),
      name: input.entry.name,
      expectedSha256: input.entry.sha256,
      idempotencyKey: randomUUID(),
      timeoutMs: 30_000,
    });
    if (!result.ok)
      throw new DomainError("CONFLICT", `Resource snapshot failed: ${result.error.message}`, { code: result.error.code });
    return new TextDecoder("utf-8", { fatal: true }).decode(result.value.contents);
  }

  /** 受限资源写入（P0-G2 服务端入口）：写副作用由调用方经工具审批授权；能力位先行校验。 */
  async writeResourceFile(input: {
    ownerUserId: string;
    runnerRowId: string;
    kind: "skill" | "agent";
    scope: "global" | "project";
    workspaceId?: string;
    relativeDir?: string;
    name: string;
    relativePath?: string;
    contents: string;
    expectedSha256?: string;
    idempotencyKey: string;
  }): Promise<{ sha256: string; sizeBytes: number; created: boolean }> {
    const view = this.views.get(input.runnerRowId);
    if (!view || view.ownerUserId !== input.ownerUserId) throw new DomainError("NOT_FOUND", "Runner directory is unavailable");
    if (!view.session.supportsLocalResources())
      throw new DomainError("CONFLICT", "Runner does not support local resource discovery", { reason: "RUNNER_UNSUPPORTED" });
    if (!view.session.supportsLocalResourceWrites())
      throw new DomainError("CONFLICT", "Runner does not support local resource writes", { reason: "RUNNER_UNSUPPORTED" });
    if (!view.session.connected) throw new DomainError("CONFLICT", "Runner is offline", { reason: "RUNNER_OFFLINE" });
    const result = await view.session.writeResourceFile({
      kind: input.kind,
      scope: input.scope,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.relativeDir ? { relativeDir: input.relativeDir } : {}),
      name: input.name,
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
      contents: new TextEncoder().encode(input.contents),
      ...(input.expectedSha256 !== undefined ? { expectedSha256: input.expectedSha256 } : {}),
      idempotencyKey: input.idempotencyKey,
      timeoutMs: 30_000,
    });
    if (!result.ok)
      throw new DomainError("CONFLICT", `Local resource write failed: ${result.error.message}`, { code: result.error.code });
    return { sha256: result.value.sha256, sizeBytes: result.value.sizeBytes, created: result.value.created };
  }

  /** skills 模块端口视图（app 组装注入）。 */
  port(): SkillDirectoryPort {
    return {
      view: (runnerRowId, ownerUserId) => this.view(runnerRowId, ownerUserId),
      refresh: (input) => this.refresh(input),
      readEntrySnapshot: (input) => this.readEntrySnapshot(input),
      writeResourceFile: (input) => this.writeResourceFile(input),
    };
  }
}
