import { z } from "zod";

export const providerSchema = z.object({
  protocol: z.enum(["openai", "anthropic"]),
  name: z.string().trim().min(1, "请输入 Provider 名称").max(80, "最多 80 个字符"),
  baseUrl: z.url("请输入有效 URL").refine((value) => value.startsWith("https://"), "只允许 HTTPS 地址"),
  credential: z.string(),
  enabled: z.boolean(),
  isPublic: z.boolean(),
});

export type ProviderFormValues = z.infer<typeof providerSchema>;
