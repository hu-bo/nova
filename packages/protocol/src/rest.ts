import { z } from "zod";
import { BlockSchema } from "./block.js";
import { DecisionResponseSchema } from "./decision.js";

export const RunnerStateSchema = z.enum(["ready", "busy", "draining", "disconnected"]);

export const RunnerTokenSchema = z.object({
  id: z.uuid(),
  token: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  boundRunnerIds: z.array(z.string().min(1)),
});
export type RunnerToken = z.infer<typeof RunnerTokenSchema>;

export const RunnerSchema = z.object({
  id: z.string().min(1),
  tokenId: z.uuid(),
  rootWorkspace: z.string().min(1),
  version: z.string(),
  platform: z.string(),
  capabilities: z.array(z.string()),
  maxConcurrency: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  state: RunnerStateSchema,
  registeredAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative(),
});
export type Runner = z.infer<typeof RunnerSchema>;

export const RunnerQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().min(1).optional(),
});
export type RunnerQuery = z.infer<typeof RunnerQuerySchema>;

export const RunnerDirectoryQuerySchema = z.object({
  runnerId: z.string().trim().min(1).max(256),
  path: z.string().trim().min(1).max(4_096).optional(),
});
export type RunnerDirectoryQuery = z.infer<typeof RunnerDirectoryQuerySchema>;

export const RunnerDirectorySchema = z.object({
  root: z.string().min(1),
  path: z.string().min(1),
  parent: z.string().min(1).nullable(),
  entries: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      kind: z.enum(["file", "directory"]),
    }),
  ),
});
export type RunnerDirectory = z.infer<typeof RunnerDirectorySchema>;

export const RunnerConnectionInfoSchema = z.object({ endpoint: z.string().url() });
export type RunnerConnectionInfo = z.infer<typeof RunnerConnectionInfoSchema>;

export const RunnerEventSchema = z.object({
  type: z.literal("runner.changed"),
  runnerId: z.string().min(1),
  state: RunnerStateSchema,
});
export type RunnerEvent = z.infer<typeof RunnerEventSchema>;

export const ModelConfigSchema = z
  .object({
    provider: z.enum(["openai", "anthropic"]),
    endpoint: z.url().refine((value) => new URL(value).protocol === "https:", "endpoint must use HTTPS"),
    model: z.string().trim().min(1),
    credential: z.string().min(1),
    contextWindow: z.number().int().positive(),
    maxOutput: z.number().int().positive(),
    reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]),
    thinkingLevels: z.array(z.enum(["off", "low", "medium", "high", "max"])),
    parallelToolCalls: z.boolean(),
    inputModalities: z.array(z.enum(["text", "image"])).min(1),
  })
  .strict();
export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const AvailableModelSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  providerName: z.string(),
  protocol: z.enum(["openai", "anthropic"]),
  visibility: z.enum(["public", "owned"]),
  contextWindow: z.number().int().positive(),
  maxOutput: z.number().int().positive(),
  reasoningFormat: z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]),
  thinkingLevels: z.array(z.enum(["off", "low", "medium", "high", "max"])),
  parallelToolCalls: z.boolean(),
  inputModalities: z.array(z.enum(["text", "image"])),
});
export type AvailableModel = z.infer<typeof AvailableModelSchema>;

export const AuthorizeUrlRequestSchema = z
  .object({
    redirect_uri: z.string().trim().min(1).max(2_048),
    state: z.string().trim().min(1).max(512),
  })
  .strict();
export type AuthorizeUrlRequest = z.infer<typeof AuthorizeUrlRequestSchema>;

export const AuthorizeUrlResponseSchema = z.object({ url: z.url() });
export type AuthorizeUrlResponse = z.infer<typeof AuthorizeUrlResponseSchema>;

export const CurrentUserSchema = z.object({
  id: z.number().int().positive(),
  casdoorId: z.string().min(1),
  username: z.string(),
  displayName: z.string(),
  role: z.string(),
  isAdmin: z.boolean(),
  isActive: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type CurrentUser = z.infer<typeof CurrentUserSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1).nullable(),
  runnerId: z.string().min(1).nullable(),
  runnerState: RunnerStateSchema,
  createdAt: z.number().int().nonnegative(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const ConversationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1).nullable(),
  runnerId: z.string().min(1).nullable(),
  title: z.string(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const MessageStatusSchema = z.enum(["streaming", "done", "error", "aborted"]);
export const ChatMessageSchema = z.object({
  id: z.string().min(1),
  conversationId: z.string().min(1),
  role: z.enum(["user", "assistant"]),
  blocks: z.array(BlockSchema),
  status: MessageStatusSchema,
  createdAt: z.number().int().nonnegative(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const CreateProjectSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
  })
  .strict();
export type CreateProject = z.infer<typeof CreateProjectSchema>;

export const UpdateProjectSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
export type UpdateProject = z.infer<typeof UpdateProjectSchema>;

export const BindProjectWorkspaceSchema = z
  .object({
    runnerId: z.string().trim().min(1),
    path: z.string().trim().min(1),
  })
  .strict();
export type BindProjectWorkspace = z.infer<typeof BindProjectWorkspaceSchema>;

export const CreateConversationSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    projectId: z.string().min(1).optional(),
    runnerId: z.string().trim().min(1).optional(),
    modelConfig: ModelConfigSchema.optional(),
    modelId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.modelConfig) !== Boolean(value.modelId), {
    message: "Exactly one of modelConfig or modelId is required",
  });
export type CreateConversation = z.infer<typeof CreateConversationSchema>;

export const UpdateConversationRunnerSchema = z
  .object({
    runnerId: z.string().trim().min(1),
  })
  .strict();
export type UpdateConversationRunner = z.infer<typeof UpdateConversationRunnerSchema>;

export const ConversationQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().min(1).optional(),
});
export type ConversationQuery = z.infer<typeof ConversationQuerySchema>;

export const MessageQuerySchema = z.object({
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type MessageQuery = z.infer<typeof MessageQuerySchema>;

export const SendMessageSchema = z
  .object({
    text: z.string().trim().min(1),
    queue: z.enum(["steering", "followUp", "nextRun"]).optional(),
    modelConfig: ModelConfigSchema.optional(),
    modelId: z.uuid().optional(),
  })
  .strict()
  .refine((value) => !(value.modelConfig && value.modelId), {
    message: "modelConfig and modelId cannot be used together",
  });
export type SendMessage = z.infer<typeof SendMessageSchema>;

export const ContextUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().nullable(),
    contextWindow: z.number().int().positive(),
  })
  .strict();
export type ContextUsage = z.infer<typeof ContextUsageSchema>;

export const CompactConversationResultSchema = z
  .object({
    compacted: z.boolean(),
    summarized: z.boolean(),
    context: ContextUsageSchema,
  })
  .strict();
export type CompactConversationResult = z.infer<typeof CompactConversationResultSchema>;

export const CreateUploadSchema = z
  .object({
    name: z.string().trim().min(1).max(255),
  })
  .strict();
export type CreateUpload = z.infer<typeof CreateUploadSchema>;

export const UploadTicketSchema = z.object({
  upload: z.url(),
  download: z.url(),
});
export type UploadTicket = z.infer<typeof UploadTicketSchema>;

export const UploadRunnerFileSchema = z
  .object({
    runnerId: z.string().trim().min(1).max(256),
    path: z.string().trim().min(1).max(4_096),
  })
  .strict();
export type UploadRunnerFile = z.infer<typeof UploadRunnerFileSchema>;

export const UploadedFileSchema = z.object({
  url: z.url(),
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  mimeType: z.string().min(1),
});
export type UploadedFile = z.infer<typeof UploadedFileSchema>;

export const ResolveDecisionSchema = DecisionResponseSchema;

export function pageSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({ items: z.array(itemSchema), nextCursor: z.string().nullable() });
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export const ApiErrorSchema = z.object({ code: z.string(), message: z.string(), requestId: z.string().optional() });
export type ApiError = z.infer<typeof ApiErrorSchema>;
