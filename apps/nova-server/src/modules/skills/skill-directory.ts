import type { SkillCatalogDiagnostic, SkillCatalogStatus } from "@nova/agent-ui-contracts";
import type { AcceptedAgentCatalog } from "./agent-definition.js";

/**
 * Runner 本地目录接缝（docs/design/nova-skills.md §4.3、P0-E1）。
 * 实现归属 runners 模块（连接态视图，存于认证 session）；skills 模块只经本接口读取，
 * 认证、归属与 workspace/canonicalCwd 校验由实现方在已认证 Runner session 下完成。
 */

export type LocalResourceKind = "skill" | "agent";
export type LocalResourceScope = "global" | "project";

/** 与 @nova/runner-sdk ResourceCatalogEntry 对齐的目录条目（来源定位 + 摘要）。 */
export interface LocalCatalogEntry {
  readonly kind: LocalResourceKind;
  readonly scope: LocalResourceScope;
  readonly workspaceId: string;
  readonly relativeDir: string;
  readonly name: string;
  readonly description: string;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface LocalCatalogView {
  readonly online: boolean;
  readonly status: SkillCatalogStatus;
  readonly revision: number;
  readonly complete: boolean;
  readonly diagnostics: readonly SkillCatalogDiagnostic[];
  readonly entries: readonly LocalCatalogEntry[];
  /** 已接受 Agent 配置（§8.1：首期由认证 session 持有，不进独立管理表）。 */
  readonly agents: readonly AcceptedAgentCatalog[];
  /** 写能力位（local_resources.write）。 */
  readonly writable: boolean;
}

export interface SkillDirectoryPort {
  /** 未连接或不支持发现能力时返回 undefined（区别于空目录，红线：不伪造空目录）。 */
  view(runnerRowId: string, ownerUserId: string): LocalCatalogView | undefined;
  /** 定向刷新并等待目录应答；失败保留旧目录并标过期（§4.3 时机与诊断）。 */
  refresh(input: {
    ownerUserId: string;
    runnerRowId: string;
    scope: LocalResourceScope;
    workspaceId?: string;
    relativeDir?: string;
  }): Promise<LocalCatalogView>;
  /** 按 entry 摘要读取快照正文；Runner 侧摘要不符返回错误（E3 不以新内容替代旧摘要）。 */
  readEntrySnapshot(input: { ownerUserId: string; runnerRowId: string; entry: LocalCatalogEntry }): Promise<string>;
  /** 受限资源写入（P0-G2）：目标由 scope+合法名+包内路径+预期摘要在 Runner 侧解析。 */
  writeResourceFile(input: {
    ownerUserId: string;
    runnerRowId: string;
    kind: LocalResourceKind;
    scope: LocalResourceScope;
    workspaceId?: string;
    relativeDir?: string;
    name: string;
    relativePath?: string;
    contents: string;
    expectedSha256?: string;
    idempotencyKey: string;
  }): Promise<{ sha256: string; sizeBytes: number; created: boolean }>;
}
