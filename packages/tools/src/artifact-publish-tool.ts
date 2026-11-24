import { defineTool, type JsonValue, type ToolDefinition } from "@nnova/harness";
import { z } from "zod";

/**
 * 宿主产物发布工具（docs/nova-skills.md §7，P1-D1）。
 * 入参仅 `{ path, name? }`；owner/会话/绑定环境/目录由服务端从当前 Run 派生，
 * 不接受模型提供标识、对象键或下载 URL（红线 2）。effects=write 走现有模式与审批；
 * Plan 模式由 allowedTools 过滤自动不安装（nova-runtime 装配）。
 */

export type ArtifactPublishHost = {
  /** path 为相对本次 Run outputDir 的文件路径；宿主校验目录边界并读取真实字节。 */
  publish(request: {
    path: string;
    name?: string | undefined;
    runId: string;
    toolExecutionId: string;
    signal: AbortSignal;
  }): Promise<{ artifactId: string; sha256: string; sizeBytes: number; replayed: boolean }>;
};

const pathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine(
    (value) =>
      !value.startsWith("/") && !/^[a-z]:/i.test(value) && !value.replaceAll("\\", "/").split("/").includes("..") && !/[\x00-\x1f]/.test(value),
    "path must be a file path relative to the Run outputDir",
  );

export function createArtifactPublishTool(host: ArtifactPublishHost): ToolDefinition[] {
  const inputSchema = z.object({ path: pathSchema, name: z.string().min(1).max(255).optional() });
  return [
    defineTool({
      name: "artifact_publish",
      description:
        "Publish one generated file from this Run's output directory as a downloadable artifact. Input is a file path relative to the outputDir given in the run context (optionally a display name). The host derives ownership, conversation and storage key from the current Run; never pass absolute paths, object keys or URLs. Returns the artifact ID, actual size and digest; reference the artifact ID in the final reply instead of local file paths. Publishing is a write action and follows the current mode and approval policy.",
      inputSchema: inputSchema as unknown as z.ZodType<JsonValue>,
      outputSchema: z.record(z.string(), z.unknown()) as unknown as z.ZodType<JsonValue>,
      effects: "write",
      async execute(input, context) {
        context.signal.throwIfAborted();
        const parsed = inputSchema.parse(input) as z.output<typeof inputSchema>;
        const result = await host.publish({
          path: parsed.path,
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          runId: context.runId,
          toolExecutionId: context.executionId,
          signal: context.signal,
        });
        return JSON.parse(JSON.stringify({ status: "ok", ...result })) as JsonValue;
      },
    }),
  ];
}
