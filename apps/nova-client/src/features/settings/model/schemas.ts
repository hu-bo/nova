import { z } from 'zod';

/**
 * 源参考 `apps/agent-web-ui/src/pages/settings/model/schemas.ts` 中 `modelProfileSchema`
 * 的等价实现 —— 完全照搬 `providerName` / `provider` / `endpoint` / `model` / `credential` /
 * `contextWindow` / `maxOutput` / `reasoningFormat` / `thinkingLevels` / `parallelToolCalls` /
 * `supportsImages` 字段，以及 maxOutput ≤ contextWindow 与 reasoningFormat ↔ thinkingLevels 联动 refine。
 */
export const modelProfileSchema = z
  .object({
    providerName: z.string().trim().min(1, '请输入配置名称').max(40, '最多 40 个字符'),
    provider: z.enum(['openai', 'anthropic']),
    endpoint: z.url('请输入有效的 API 地址').refine((value) => {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    }, '请使用 HTTPS 或本机 HTTP 地址'),
    model: z.string().trim().min(1, '请输入模型名称'),
    credential: z.string(),
    contextWindow: z.number().int().positive('必须大于 0'),
    maxOutput: z.number().int().positive('必须大于 0'),
    reasoningFormat: z.enum(['none', 'openai', 'anthropic', 'deepseek', 'minimax']),
    thinkingLevels: z.array(z.enum(['off', 'low', 'medium', 'high', 'max'])),
    parallelToolCalls: z.boolean(),
    supportsImages: z.boolean(),
  })
  .refine((value) => value.maxOutput <= value.contextWindow, {
    path: ['maxOutput'],
    message: '不能大于上下文窗口',
  })
  .refine(
    (value) =>
      value.reasoningFormat === 'none'
        ? value.thinkingLevels.length === 0
        : value.thinkingLevels.length > 0,
    {
      path: ['thinkingLevels'],
      message: '推理格式与支持的强度不匹配',
    },
  );

export type ModelProfileForm = z.infer<typeof modelProfileSchema>;

export type ModelReasoningFormat = ModelProfileForm['reasoningFormat'];
export type ModelThinkingLevel = ModelProfileForm['thinkingLevels'][number];

export const THINKING_LEVELS: readonly ModelThinkingLevel[] = [
  'off',
  'low',
  'medium',
  'high',
  'max',
] as const;

export const REASONING_FORMATS: readonly ModelReasoningFormat[] = [
  'none',
  'openai',
  'anthropic',
  'deepseek',
  'minimax',
] as const;

export const PROVIDERS: readonly ModelProfileForm['provider'][] = ['openai', 'anthropic'] as const;

export function emptyModelProfile(): ModelProfileForm {
  return {
    providerName: '',
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    model: '',
    credential: '',
    contextWindow: 200_000,
    maxOutput: 16_384,
    reasoningFormat: 'openai',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
    parallelToolCalls: true,
    supportsImages: true,
  };
}
