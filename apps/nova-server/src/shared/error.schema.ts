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
