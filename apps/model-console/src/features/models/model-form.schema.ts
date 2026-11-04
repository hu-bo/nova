import { z } from "zod";

const price = z.string().regex(/^\d+(\.\d{1,8})?$/, "请输入非负金额，最多 8 位小数");

/** 自定义校验失败：挂到指定字段，避免每条规则手工拼装 issue 对象。 */
const customIssue = (input: unknown, path: [string], message: string) => ({
  input,
  code: "custom" as const,
  path,
  message,
});
export const modelSchema = z
  .object({
    publicName: z.string().trim().min(1, "请输入公开模型名").max(100),
    providerId: z.string().min(1, "请选择 Provider"),
    upstreamName: z.string().trim().min(1, "请输入上游模型名").max(150),
    contextWindow: z.number().int().positive("必须大于 0"),
    maxOutput: z.number().int().positive("必须大于 0"),
    thinkingLevels: z.array(z.enum(["off", "low", "medium", "high", "max"])),
    parallelToolCalls: z.boolean(),
    reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]),
    inputModalities: z.array(z.enum(["text", "image"])),
    enabled: z.boolean(),
    priceIn: price,
    priceOut: price,
    priceCacheRead: price,
  })
  .check(({ value: values, issues }) => {
    if (values.maxOutput > values.contextWindow)
      issues.push(customIssue(values.maxOutput, ["maxOutput"], "不能超过上下文窗口"));
    if (!values.inputModalities.includes("text"))
      issues.push(customIssue(values.inputModalities, ["inputModalities"], "必须支持文本输入"));
    if (new Set(values.thinkingLevels).size !== values.thinkingLevels.length)
      issues.push(customIssue(values.thinkingLevels, ["thinkingLevels"], "Thinking 等级不能重复"));
    if (values.reasoningFormat === "none" && values.thinkingLevels.length > 0)
      issues.push(customIssue(values.thinkingLevels, ["thinkingLevels"], "无 reasoning 格式时等级必须为空"));
    if (values.reasoningFormat !== "none" && values.thinkingLevels.length === 0)
      issues.push(customIssue(values.thinkingLevels, ["thinkingLevels"], "请选择至少一个 Thinking 等级"));
  });

export type ModelFormValues = z.infer<typeof modelSchema>;
