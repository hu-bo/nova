import { z } from "zod";
import { interactionResponseSchema, interactionSchema, runViewSchema } from "@nova/agent-ui-contracts";
export const runSchema = runViewSchema;
export const runCancelResponseSchema = runViewSchema;
export const runParamsSchema = z.object({ id: z.uuid() }).strict();
export const interactionParamsSchema = runParamsSchema.extend({ interactionId: z.string().min(1).max(128) }).strict();
export const respondInteractionBodySchema = z
  .object({ expectedRevision: z.number().int().positive(), response: interactionResponseSchema })
  .strict();
export const interactionResponseResultSchema = interactionSchema;
export { errorResponseSchema } from "../../shared/error.schema.js";
export { okEnvelope, success } from "../../shared/response.schema.js";
