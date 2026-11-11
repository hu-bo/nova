import { z } from "zod";

export const providerSchema = z.object({
  adapterId: z.string(),
  name: z.string().trim().min(1, "请输入 Provider 名称").max(80, "最多 80 个字符"),
  baseUrl: z
    .string()
    .trim()
    .max(2048, "地址不能超过 2048 个字符")
    .pipe(z.url("请输入有效 URL"))
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "请使用不含用户名和密码的 HTTPS 地址"),
  credential: z.string(),
  enabled: z.boolean(),
  isPublic: z.boolean(),
});

export type ProviderFormValues = z.infer<typeof providerSchema>;
