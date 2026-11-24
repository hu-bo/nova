import { z } from "zod";
import { idSchema, publicErrorSchema } from "./messages.js";
import { runStateSchema } from "./runtime.js";

/**
 * 文件产物共享契约（docs/nova-skills.md §7、§8.1、P1-A1）。
 * 产物状态只描述文件发布（publishing/ready/failed）；执行结果仍读 `runs.state`，
 * 不维护第二套技能运行状态机。归属由 Run→会话链派生，事件仅带定位三元组，
 * 客户端据事件刷新 `GET /conversations/:id/artifacts`。
 */
export const artifactStateSchema = z.enum(["publishing", "ready", "failed"]);
export type ArtifactState = z.infer<typeof artifactStateSchema>;

/**
 * 预览策略单来源（服务端按类型矩阵派生，客户端不手写白名单）：
 * markdown/text 走受限文本接口；image 允许短期 URL；html/svg 等主动内容强制下载；
 * Office/PDF 首版仅下载（§7 下载段）。
 */
export const artifactPreviewKindSchema = z.enum(["markdown", "text", "image", "download"]);
export type ArtifactPreviewKind = z.infer<typeof artifactPreviewKindSchema>;

export const artifactSummarySchema = z
  .object({
    id: idSchema,
    runId: idSchema,
    /** 产物归属本次用户技能；仅内置或普通会话时按实际来源记录或留空（§8.1 末段）。 */
    skillVersionId: idSchema.nullable(),
    name: z.string().min(1).max(255),
    mimeType: z.string().min(1).max(128),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/i)
      .nullable(),
    state: artifactStateSchema,
    preview: artifactPreviewKindSchema,
    /** 来源 Run 生命周期状态：卡片「产物保留但任务未通过」的展示依据（§7 窗口表）；执行结果唯一来源仍是 runs.state。 */
    runState: runStateSchema,
    error: publicErrorSchema.optional(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export type ArtifactSummary = z.infer<typeof artifactSummarySchema>;
