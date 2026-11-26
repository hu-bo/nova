import { createHash } from "node:crypto";
import type { ArtifactSummary, ArtifactPreviewKind, PublicError } from "@nova/agent-ui-contracts";
import type { RunState } from "../../../database/index.js";
import { DomainError } from "../../shared/domain-error.js";
import type { RunClaim } from "../runs/index.js";
import {
  ARTIFACT_OBJECT_PREFIX,
  artifactObjectKey,
  artifactPreviewKind,
  downloadTtlSeconds,
  guessArtifactMimeType,
  MAX_ARTIFACT_BYTES,
  MAX_ARTIFACT_BYTES_PER_RUN,
  MAX_ARTIFACT_FILES_PER_RUN,
  MAX_PREVIEW_TEXT_BYTES,
  ORPHAN_PROTECTION_DAYS,
  previewTtlSeconds,
  type ArtifactObjectStorage,
} from "./object-storage.js";
import type { ArtifactRepository } from "./artifact.repository.js";
import type { ArtifactRow } from "./artifact.repository.js";
import type { ArtifactSettlement } from "../runs/index.js";

/**
 * 产物发布、恢复与下载授权（docs/design/nova-skills.md §7，P1-D2/E1）。
 * 崩溃窗口处理与 §7 窗口表一致：
 * - 对象已传、结算前退出 → 恢复按稳定发布键核对对象大小后完成结算，返回同一产物 ID；
 * - 上传超时结果未知 → 保留 publishing 待核实，不重新生成文件；
 * - NotFound 且旧上传未确认停止 → 保留待核实，不把一次 NotFound 当作重新派发依据；
 * - 失败已知 → 记录原因、释放额度（failed 不再计入 quota）、文件留工作区；
 * - 发布成功后 Run 失败/取消 → 产物保留（卡片展示来源 Run 结果，属客户端语义）。
 * 索引变化与 `artifact.changed` 事件经 runs 域 settlement 端口同事务提交；
 * 网络上传期间不持有数据库事务；旧 fence 不能提交。
 */

export type PublishRequest = {
  claim: RunClaim;
  toolExecutionId: string;
  skillVersionId: string | null;
  /** 显示文件名（不参与对象键拼接，§5.2）。 */
  display: string;
  /** 宿主已解析并校验相对 outputDir 的文件路径；读字节回调（Runner fs.readBytes）。 */
  readBytes: () => Promise<Uint8Array>;
};

export type PublishResult = { artifactId: string; sha256: string; sizeBytes: number; replayed: boolean };

export class ArtifactService {
  constructor(
    private readonly artifacts: ArtifactRepository,
    private readonly settlement: ArtifactSettlement,
    private readonly storage: ArtifactObjectStorage,
    private readonly transaction: <T>(run: (scope: { artifacts: ArtifactRepository; settlement: ArtifactSettlement }) => Promise<T>) => Promise<T>,
  ) {}

  async publish(request: PublishRequest): Promise<PublishResult> {
    // 1) 事务外：读取真实字节并冻结摘要（源变化在恢复窗口按摘要冲突处理）。
    let bytes: Uint8Array;
    try {
      bytes = await request.readBytes();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError("CONFLICT", `Artifact source file is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const size = bytes.byteLength;
    const mimeType = guessArtifactMimeType(request.display);
    const preview: ArtifactPreviewKind | undefined = mimeType ? artifactPreviewKind(mimeType, request.display) : undefined;

    // 2) 事务内：claim 可写校验 + 稳定发布键预留（重放返回原记录，不新建产物）。
    const reserved = await this.transaction(async ({ artifacts, settlement }) => {
      await settlement.assertWritable(request.claim);
      return artifacts.reserve({
        runId: request.claim.id,
        toolExecutionId: request.toolExecutionId,
        name: request.display,
        skillVersionId: request.skillVersionId,
      });
    });
    const row = reserved.row;
    if (reserved.created) {
      const quota = await this.quotaForRun(request.claim.id);
      const rejection = publicationRejection(size, request.display, mimeType, preview, quota);
      if (rejection)
        return this.failKnown(row, request.claim, rejection, {
          sha256,
          size,
          mimeType: mimeType ?? "application/octet-stream",
        });
    }
    if (row.state === "ready")
      return { artifactId: row.id, sha256: row.sha256 ?? sha256, sizeBytes: row.size, replayed: true };
    if (row.state === "failed" && !reserved.created)
      throw new DomainError("CONFLICT", `Artifact publish previously failed: ${row.error?.message ?? "unknown"}`, {
        reason: "ARTIFACT_FAILED",
      });

    // 3) 已有冻结摘要 → 先做恢复核对（对象可能已在 MinIO，上传后崩溃窗口）。
    if (row.objectKey && row.sha256 && row.size > 0) {
      if (row.sha256 !== sha256)
        throw new DomainError("CONFLICT", "Source file changed after the pinned publication; re-publish with a new execution", {
          reason: "ARTIFACT_SOURCE_CHANGED",
        });
      const settled = await this.reconcile(row, request.claim);
      if (settled) return { artifactId: row.id, sha256: row.sha256, sizeBytes: row.size, replayed: true };
    } else {
      // 无事实（早期崩溃/全新发布）：持久化摘要/大小/对象键后再上传。
      const objectKey = artifactObjectKey({
        ownerUserId: await this.ownerOf(request.claim.id),
        conversationId: request.claim.conversationId,
        runId: request.claim.id,
        artifactId: row.id,
        sha256,
      });
      await this.transaction(async ({ artifacts }) =>
        artifacts.recordFacts(row.id, {
          sha256,
          size,
          objectKey,
          mimeType: mimeType ?? "application/octet-stream",
          preview: preview ?? "download",
          recovery: { uploadStarted: false, frozenSha256: sha256 },
        }),
      );
    }

    // 4) 事务外上传不可变键（幂等：同键同字节）。
    const fresh = await this.artifactOrConflict(row.id);
    await this.transaction(async ({ artifacts }) =>
      artifacts.patchRecovery(fresh.id, { ...(fresh.recovery ?? {}), uploadStarted: true }),
    );
    try {
      await this.storage.putObject(fresh.objectKey!, bytes, fresh.mimeType);
    } catch (error) {
      // 结果已知（拒绝/超限）→ 失败释放额度；超时/网络未知 → publishing 待核实。
      if (isDefiniteFailure(error)) {
        return this.failKnown(fresh, request.claim, {
          code: "STORAGE_FAILED",
          message: `Artifact upload failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      throw new DomainError("EXECUTION_OUTCOME_UNKNOWN", "Artifact upload outcome unknown; reconcile before retrying", {
        reason: "UPLOAD_OUTCOME_UNKNOWN",
        artifactId: fresh.id,
      });
    }

    // 5) 上传确认后：同事务校验 fence → 标 ready → 释放预留 → 提交 artifact.changed。
    await this.transaction(({ artifacts, settlement }) =>
      settlement.settle(request.claim, { artifactId: fresh.id, state: "ready" }, () =>
        artifacts.markReady(fresh.id, { uploadConfirmedAt: new Date().toISOString() }).then(() => undefined),
      ),
    );
    return { artifactId: fresh.id, sha256, sizeBytes: size, replayed: false };
  }

  /**
   * 恢复核对：按发布键找到 publishing 记录，查原对象并校验大小；
   * 无法确认时保留待核实，继续沿原操作协调，不重新生成文件。
   */
  private async reconcile(row: ArtifactRow, claim: RunClaim): Promise<boolean> {
    let stat: { size: number } | undefined;
    try {
      stat = await this.storage.statObject(row.objectKey!);
    } catch {
      throw new DomainError("EXECUTION_OUTCOME_UNKNOWN", "Artifact storage state unknown; keep the record pending", {
        reason: "UPLOAD_OUTCOME_UNKNOWN",
        artifactId: row.id,
      });
    }
    if (stat && stat.size === row.size) {
      await this.transaction(({ artifacts, settlement }) =>
        settlement.settle(claim, { artifactId: row.id, state: "ready" }, () =>
          artifacts.markReady(row.id, { reconciledAt: new Date().toISOString() }).then(() => undefined),
        ),
      );
      return true;
    }
    if (!stat && row.recovery && "uploadStarted" in row.recovery && row.recovery.uploadStarted === true) {
      // NotFound 但旧上传不能确认停止：保留待核实，不重新派发。
      throw new DomainError("EXECUTION_OUTCOME_UNKNOWN", "Object not found and the previous upload is not confirmed stopped", {
        reason: "UPLOAD_OUTCOME_UNKNOWN",
        artifactId: row.id,
      });
    }
    return false;
  }

  private async ownerOf(runId: string): Promise<string> {
    const ownership = await this.settlement.resolveRunOwnership(runId);
    if (!ownership) throw new DomainError("NOT_FOUND", "Run is unavailable");
    return ownership.ownerUserId;
  }

  private async artifactOrConflict(artifactId: string): Promise<ArtifactRow> {
    const row = await this.artifacts.find(artifactId);
    if (!row) throw new DomainError("NOT_FOUND", "Artifact is unavailable");
    return row;
  }

  private async quotaForRun(runId: string) {
    return this.artifacts.quotaForRun(runId);
  }

  private async failKnown(
    row: ArtifactRow,
    claim: RunClaim,
    error: PublicError,
    facts?: { sha256: string; size: number; mimeType: string },
  ): Promise<never> {
    await this.transaction(({ artifacts, settlement }) =>
      settlement.settle(claim, { artifactId: row.id, state: "failed" }, async () => {
        // 记录失败原因；failed 行不再计入额度（§7 窗口表：失败已知 → 释放预留）。
        await artifacts.markFailed(row.id, error, { failedAt: new Date().toISOString() }, facts);
      }),
    );
    throw new DomainError("CONFLICT", error.message, { reason: error.code, artifactId: row.id });
  }

  // ---------- 读接口（P1-E1） ----------

  async list(input: { conversationId: string; ownerUserId: string; limit: number; cursor?: string }) {
    const runIds = await this.settlement.runIdsForConversation(input.conversationId, input.ownerUserId);
    const cursor = input.cursor ? parseCursor(input.cursor) : undefined;
    if (input.cursor && !cursor) throw new DomainError("VALIDATION_ERROR", "Invalid cursor");
    const rows = await this.artifacts.listForRuns(runIds, { limit: input.limit, ...(cursor ? { cursor } : {}) });
    const page = rows.slice(0, input.limit);
    const states = await this.settlement.runStatesForIds([...new Set(page.map((row) => row.runId))]);
    const stateByRun = new Map(states.map((row) => [row.id, row.state]));
    const last = page.at(-1);
    return {
      items: page.map((row) => artifactView(row, stateByRun.get(row.runId)!)),
      nextCursor: rows.length > input.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }

  /** 下载：先验证 产物→Run→会话→当前用户/项目，再签短期 URL；不接受任意 object key 换签。 */
  async download(artifactId: string, ownerUserId: string) {
    const row = await this.authorized(artifactId, ownerUserId);
    if (row.state !== "ready" || !row.objectKey)
      throw new DomainError("CONFLICT", "Artifact is not downloadable in its current state", { state: row.state });
    const signed = await this.storage.presignGet(row.objectKey, {
      expiresSeconds: downloadTtlSeconds(),
      downloadFileName: row.name,
    });
    return { name: row.name, mimeType: row.mimeType, size: row.size, state: row.state, ...signed };
  }

  /** 预览：Markdown/纯文本受限内容；允许图片短期 URL；HTML/SVG 等主动内容只返回下载。 */
  async preview(artifactId: string, ownerUserId: string): Promise<PreviewResult> {
    const row = await this.authorized(artifactId, ownerUserId);
    if (row.state !== "ready")
      throw new DomainError("CONFLICT", "Artifact is not previewable in its current state", { state: row.state });
    const kind = row.preview;
    if (kind === "download") return { kind, name: row.name, mimeType: row.mimeType };
    if (kind === "image") {
      const signed = await this.storage.presignGet(row.objectKey!, { expiresSeconds: previewTtlSeconds() });
      return { kind, name: row.name, mimeType: row.mimeType, url: signed.url, expiresAt: signed.expiresAt };
    }
    const object = await this.storage.readObject(row.objectKey!, MAX_PREVIEW_TEXT_BYTES);
    if (!object) throw new DomainError("NOT_FOUND", "Artifact object is unavailable");
    return {
      kind,
      name: row.name,
      mimeType: row.mimeType,
      text: new TextDecoder("utf-8").decode(object.body),
      truncated: object.truncated,
    };
  }

  /** 交付结算判定（§7 窗口表末行）：技能要求必须交付时，宿主按 ready 产物数结算。 */
  async hasReadyArtifacts(runId: string): Promise<boolean> {
    return (await this.artifacts.countReadyForRun(runId)) > 0;
  }

  /** 是否仍有 publishing 预留未结算（tmp 清理的「所有发布已结算」前置）。 */
  async hasPendingPublications(runId: string): Promise<boolean> {
    return (await this.artifacts.countPendingForRun(runId)) > 0;
  }

  // ---------- 清理（P1-F1） ----------

  /** `artifact.purge` Job handler：会话删除事务里收集的对象键；重复执行幂等（NotFound 由存储层吞掉）。 */
  async handlePurgeJob(payload: Record<string, unknown>): Promise<{ removed: number }> {
    const keys = Array.isArray(payload.keys) ? payload.keys.filter((key): key is string => typeof key === "string") : [];
    for (const key of keys) await this.storage.removeObject(key);
    return { removed: keys.length };
  }

  /**
   * 定期孤儿扫描兜底：只处理产物前缀形状且满足保护期（未被数据库索引引用 + lastModified 超期）的对象。
   * publishing 记录与有效预留都被索引引用保护；TTL 值留在配置（此处默认 7 天保护期）。
   */
  async scanOrphans(now = new Date()): Promise<{ scanned: number; removed: number }> {
    const graceMs = ORPHAN_PROTECTION_DAYS * 24 * 60 * 60 * 1000;
    const referenced = new Set(
      (await this.artifacts.referencedObjectKeys())
        .map((row) => row.key)
        .filter((key): key is string => Boolean(key)),
    );
    const objects = await this.storage.listObjects(ARTIFACT_OBJECT_PREFIX);
    let removed = 0;
    for (const object of objects) {
      if (referenced.has(object.key)) continue;
      if (!isArtifactKeyShape(object.key)) continue;
      if (object.lastModified.getTime() > now.getTime() - graceMs) continue;
      await this.storage.removeObject(object.key);
      removed += 1;
    }
    return { scanned: objects.length, removed };
  }

  private async authorized(artifactId: string, ownerUserId: string): Promise<ArtifactRow> {
    const row = await this.artifactOrConflict(artifactId);
    const ownership = await this.settlement.resolveRunOwnership(row.runId);
    if (!ownership || ownership.ownerUserId !== ownerUserId) throw new DomainError("NOT_FOUND", "Artifact is unavailable");
    return row;
  }
}

export type PreviewResult =
  | { kind: "markdown" | "text"; name: string; mimeType: string; text: string; truncated: boolean }
  | { kind: "image"; name: string; mimeType: string; url: string; expiresAt: string }
  | { kind: "download"; name: string; mimeType: string };

function artifactView(row: ArtifactRow, runState: RunState): ArtifactSummary {
  return {
    id: row.id,
    runId: row.runId,
    skillVersionId: row.skillVersionId,
    name: row.name,
    mimeType: row.mimeType,
    size: Number(row.size),
    sha256: row.sha256,
    state: row.state,
    preview: row.preview,
    runState,
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseCursor(cursor: string): { createdAt: Date; id: string } | undefined {
  const [date, id] = cursor.split("|");
  if (!date || !id) return undefined;
  const createdAt = new Date(date);
  return Number.isNaN(createdAt.getTime()) ? undefined : { createdAt, id };
}

/** 发布前置校验的机器可读拒绝原因（guard 顺序 = 原三元链顺序，行为一致）。 */
function publicationRejection(
  size: number,
  display: string,
  mimeType: string | undefined,
  preview: ArtifactPreviewKind | undefined,
  quota: { files: number; bytes: number },
): PublicError | undefined {
  if (size > MAX_ARTIFACT_BYTES)
    return { code: "TOO_LARGE", message: `Artifact exceeds the ${MAX_ARTIFACT_BYTES / (1024 * 1024)} MiB limit for this host` };
  if (mimeType === undefined || preview === undefined)
    return { code: "UNSUPPORTED_MEDIA", message: `File type is not publishable: ${display}` };
  if (quota.files > MAX_ARTIFACT_FILES_PER_RUN || quota.bytes + size > MAX_ARTIFACT_BYTES_PER_RUN)
    return { code: "QUOTA_EXCEEDED", message: "Run artifact quota exhausted" };
  return undefined;
}

function isDefiniteFailure(error: unknown): boolean {
  const code = (error as { code?: string } | undefined)?.code ?? "";
  return code === "AccessDenied" || code === "XMinioInvalidObjectName" || code === "BadRequest";
}

/** 只回收本模块键形状 `artifacts/<owner>/<conversation>/<run>/<artifact>/<sha256>`（5 段 + 前缀 + 末段摘要），不触碰桶内其它数据。 */
function isArtifactKeyShape(key: string): boolean {
  const segments = key.split("/");
  return segments.length === 6 && segments[0] === "artifacts" && /^[a-f0-9]{64}$/i.test(segments[5]!);
}
