import { z } from "zod";

export const errorResponseSchema = z.object({
  /** 数字错误码(400/401/404/409/500…);与真实 HTTP 状态码一致 */
  code: z.number().int(),
  /** 数字业务码,与 code 对齐 HTTP 状态码(400/404/409/413/500…);前端按 status 直接映射 messages 表 */
  subCode: z.number().int().optional(),
  message: z.string(),
  requestId: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

/**
 * 路由 schema 中错误响应声明的简写: errorResponses(401, 404) 等价于
 * { 401: errorResponseSchema, 404: errorResponseSchema }。
 * 逐路由声明的状态码集合保持不变, 因此 OpenAPI 文档输出与内联写法完全一致。
 */
export function errorResponses<const Codes extends readonly number[]>(
  ...codes: Codes
): Record<Codes[number], typeof errorResponseSchema> {
  return Object.fromEntries(codes.map((code) => [code, errorResponseSchema])) as Record<
    Codes[number],
    typeof errorResponseSchema
  >;
}
