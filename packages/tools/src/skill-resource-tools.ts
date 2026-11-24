import { defineTool, type JsonValue, type ToolDefinition } from "@nnova/harness";
import { z } from "zod";

/**
 * 技能源安装工具（docs/nova-skills.md §4.4、P0-G2/G3）。
 * 目标路径由宿主从 `scope + 合法技能名 + 包内相对路径 + 预期摘要` 解析，
 * 只允许写入已知技能源根；不提供任意绝对路径或 home 文件写入（红线 3）。
 * 依赖宿主传入的窄接口，不导入数据库或 MinIO。
 */

export type SkillResourceWriteInput = {
  scope: "project" | "global";
  name: string;
  path: string;
  contents: string;
  expectedSha256?: string | undefined;
};

export type SkillResourceWriteHost = {
  /** 实际写入（Runner 解析目标并做摘要 CAS/仅创建保护）。 */
  write(input: SkillResourceWriteInput): Promise<{ sha256: string; sizeBytes: number; created: boolean }>;
  /** 写入成功后定向刷新对应目录，返回目录状态（区分「已写入」与「已被目录发现」）。 */
  refresh(scope: "project" | "global"): Promise<{ status: string; revision: number; complete: boolean }>;
};

const skillNameSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/).max(64);
const writeInputSchema = z.object({
  scope: z.enum(["project", "global"]),
  name: skillNameSchema,
  path: z.string().min(1).max(512).optional(),
  contents: z.string().min(1).max(256 * 1024),
  expectedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
});
type WriteInput = z.output<typeof writeInputSchema>;

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function createSkillResourceTools(host: SkillResourceWriteHost): ToolDefinition[] {
  return [
    defineTool({
      name: "skill_write_resource",
      description:
        "Install or update one file inside a known Nova skill source root: project scope writes <projectRoot>/.nova/skills/<name>/, global scope writes the Runner user home ~/.nova/skills/<name>/. The host resolves the target from scope, a validated skill name, the package-relative path and the expected digest; arbitrary paths are rejected. Provide expectedSha256 of the current entry file to protect against concurrent edits; omit it to create a new skill (fails if the file already exists). After a successful write the host refreshes the corresponding local catalog and reports its state.",
      inputSchema: writeInputSchema as unknown as z.ZodType<JsonValue>,
      outputSchema: z.record(z.string(), z.unknown()) as unknown as z.ZodType<JsonValue>,
      effects: "write",
      async execute(input, context) {
        context.signal.throwIfAborted();
        const parsed = writeInputSchema.parse(input) as WriteInput;
        const written = await host.write({ ...parsed, path: parsed.path ?? "SKILL.md" });
        const catalog = await host.refresh(parsed.scope);
        return toJson({ ...written, catalog });
      },
    }),
  ];
}
