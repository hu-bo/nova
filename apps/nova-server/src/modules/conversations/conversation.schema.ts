import { z } from "zod";
import {
  configurationSchema,
  conversationSchema as coreConversationSchema,
  decimalSequenceSchema,
  goalInputSchema,
  goalSchema,
  inputBlocksSchema,
  inputReceiptSchema,
  messagePageSchema,
  messageSchema,
  snapshotSchema,
  submitInputSchema,
  attachmentSchema,
} from "@nova/agent-ui-contracts";
import { errorResponseSchema } from "../../shared/error.schema.js";
import { okEnvelope, success } from "../../shared/response.schema.js";
import { bindingSchema } from "../projects/index.js";
export const runtimeConfigurationSchema = configurationSchema;
export const conversationGoalSchema = goalSchema;
export { goalInputSchema, attachmentSchema, messageSchema, messagePageSchema };
export const conversationSchema = coreConversationSchema.extend({
  activeRunId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const conversationSnapshotSchema = snapshotSchema.extend({ binding: bindingSchema.nullable() });
export const createConversationBodySchema = z
  .object({
    mode: z.enum(["chat", "project"]),
    projectId: z.uuid().optional(),
    title: z.string().trim().min(1).max(200).optional(),
    configuration: configurationSchema.optional(),
    goal: goalInputSchema.optional(),
    initialInput: z.object({ blocks: inputBlocksSchema }).strict().optional(),
  })
  .strict()
  .refine((input) => input.mode !== "project" || Boolean(input.projectId), "Project conversation requires projectId");
export const pendingInputBodySchema = submitInputSchema.extend({ goal: goalInputSchema.optional() }).strict();
export const pendingInputReceiptSchema = inputReceiptSchema;
export const conversationParamsSchema = z.object({ id: z.uuid() }).strict();
export const pendingInputParamsSchema = conversationParamsSchema.extend({ inputId: z.uuid() }).strict();
export const messageQuerySchema = z.object({ before: decimalSequenceSchema.optional() }).strict();
export const updateConversationBodySchema = z.object({ title: z.string().trim().min(1).max(200) }).strict();
export const updateConversationGoalSchema = z
  .object({ action: z.enum(["pause", "resume", "complete", "remove"]), expectedRevision: z.number().int().positive() })
  .strict();
export const conversationListSchema = z.object({ items: z.array(conversationSchema) });
export { errorResponseSchema, okEnvelope, success };
export type CreateConversationInput = z.infer<typeof createConversationBodySchema>;
export type ConversationDTO = z.infer<typeof conversationSchema>;
export type ConversationSnapshotDTO = z.infer<typeof conversationSnapshotSchema>;
export type RuntimeConfiguration = z.infer<typeof configurationSchema>;
export type GoalInput = z.infer<typeof goalInputSchema>;
export type { Attachment, InputReceipt as PendingInputReceipt } from "@nova/agent-ui-contracts";
