import { z } from "zod";

export const modelProfileSchema = z
  .object({
    providerName: z.string().trim().min(1, "请输入配置名称").max(40, "最多 40 个字符"),
    provider: z.enum(["openai", "anthropic"]),
    endpoint: z
      .url("请输入有效的 HTTPS 地址")
      .refine((value) => new URL(value).protocol === "https:", "必须使用 HTTPS"),
    model: z.string().trim().min(1, "请输入模型名称"),
    credential: z.string().min(1, "请输入 API Key"),
    contextWindow: z.number().int().positive("必须大于 0"),
    maxOutput: z.number().int().positive("必须大于 0"),
    reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]),
    thinkingLevels: z.array(z.enum(["off", "low", "medium", "high", "max"])),
    parallelToolCalls: z.boolean(),
    supportsImages: z.boolean(),
  })
  .refine((value) => value.maxOutput <= value.contextWindow, {
    path: ["maxOutput"],
    message: "不能大于上下文窗口",
  })
  .refine(
    (value) => (value.reasoningFormat === "none" ? value.thinkingLevels.length === 0 : value.thinkingLevels.length > 0),
    {
      path: ["thinkingLevels"],
      message: "推理格式与支持的强度不匹配",
    },
  );

export type ModelProfileForm = z.infer<typeof modelProfileSchema>;
