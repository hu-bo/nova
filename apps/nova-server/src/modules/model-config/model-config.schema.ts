import { z } from "zod";
import { providerCatalog, providerIds } from "@nnova/harness/plugins/model-ai-sdk";

export const providerProtocolSchema = z.enum(["openai", "anthropic"]);
export const thinkingLevelSchema = z.enum(["off", "low", "medium", "high", "max"]);
export const reasoningFormatSchema = z.enum(["none", "openai", "anthropic", "deepseek", "minimax"]);
export const providerAdapterSchema = z.enum(providerIds);
export const providerAdapterDescriptorSchema = z.object({
  id: providerAdapterSchema,
  label: z.string(),
  defaultBaseURL: z.string().url(),
  protocol: providerProtocolSchema,
  reasoningFormat: reasoningFormatSchema,
  thinkingLevels: z.array(thinkingLevelSchema),
});
export const inputModalitySchema = z.enum(["text", "image"]);
const priceSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,8})?$/, "Price must be non-negative and fit 12 integer digits plus 8 decimals");

const baseUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url()
  .refine((value) => {
    const url = URL.parse(value);
    return url !== null && url.protocol === "https:" && !url.username && !url.password;
  }, "Provider URL must use HTTPS and cannot contain URL credentials");

export const createProviderBodySchema = z
  .object({
    adapterId: providerAdapterSchema.optional(),
    protocol: providerProtocolSchema.optional(),
    name: z.string().trim().min(1).max(80),
    baseUrl: baseUrlSchema,
    credential: z.string().trim().min(1).max(4096),
    enabled: z.boolean().default(false),
    isPublic: z.boolean().default(false),
  })
  .strict()
  .refine((input) => input.adapterId !== undefined || input.protocol !== undefined, "Choose a provider adapter")
  .refine(
    (input) =>
      !input.adapterId ||
      !input.protocol ||
      providerCatalog.find((item) => item.id === input.adapterId)?.protocol === input.protocol,
    "Protocol does not match the provider adapter",
  );

export const updateProviderBodySchema = z
  .object({
    adapterId: providerAdapterSchema.optional(),
    protocol: providerProtocolSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: baseUrlSchema.optional(),
    credential: z.string().max(4096).optional(),
    enabled: z.boolean().optional(),
    isPublic: z.boolean().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field must be supplied");

const modelPropertiesSchema = z
  .object({
    publicName: z.string().trim().min(1).max(100),
    providerId: z.string().uuid(),
    upstreamName: z.string().trim().min(1).max(150),
    contextWindow: z.number().int().positive().max(10_000_000),
    maxOutput: z.number().int().positive().max(10_000_000),
    thinkingLevels: z.array(thinkingLevelSchema).max(5).default([]),
    parallelToolCalls: z.boolean().default(true),
    reasoningFormat: reasoningFormatSchema.optional(),
    inputModalities: z.array(inputModalitySchema).min(1).max(2).default(["text"]),
    enabled: z.boolean().default(false),
    priceIn: priceSchema.default("0"),
    priceOut: priceSchema.default("0"),
    priceCacheRead: priceSchema.default("0"),
  })
  .strict();

export const modelConfigurationSchema = modelPropertiesSchema.superRefine((model, context) => {
  if (model.maxOutput > model.contextWindow) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maxOutput"], message: "Cannot exceed contextWindow" });
  }
  if (!model.inputModalities.includes("text")) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["inputModalities"], message: "Text input is required" });
  }
  if (new Set(model.thinkingLevels).size !== model.thinkingLevels.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinkingLevels"],
      message: "Thinking levels cannot repeat",
    });
  }
  if (model.reasoningFormat === "none" && model.thinkingLevels.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinkingLevels"],
      message: "Levels require a reasoning format",
    });
  }
  if (model.reasoningFormat && model.reasoningFormat !== "none" && model.thinkingLevels.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["thinkingLevels"],
      message: "Choose at least one thinking level",
    });
  }
});

export const createModelBodySchema = modelConfigurationSchema;
export const updateModelBodySchema = modelPropertiesSchema
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, "At least one field must be supplied");

export const providerIdParamsSchema = z.object({ providerId: z.string().uuid() }).strict();
export const modelIdParamsSchema = z.object({ modelId: z.string().uuid() }).strict();

export const providerSchema = z.object({
  id: z.string().uuid(),
  adapterId: providerAdapterSchema.nullable(),
  protocol: providerProtocolSchema,
  name: z.string(),
  baseUrl: z.string().url(),
  credentialMasked: z.string(),
  enabled: z.boolean(),
  isPublic: z.boolean(),
  ownerId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const modelSchema = z.object({
  id: z.string().uuid(),
  publicName: z.string(),
  providerId: z.string().uuid(),
  providerName: z.string(),
  upstreamName: z.string(),
  contextWindow: z.number().int(),
  maxOutput: z.number().int(),
  thinkingLevels: z.array(thinkingLevelSchema),
  parallelToolCalls: z.boolean(),
  reasoningFormat: reasoningFormatSchema,
  inputModalities: z.array(inputModalitySchema),
  enabled: z.boolean(),
  priceIn: z.string(),
  priceOut: z.string(),
  priceCacheRead: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type CreateProviderInput = z.infer<typeof createProviderBodySchema>;
export type UpdateProviderInput = z.infer<typeof updateProviderBodySchema>;
export type CreateModelInput = z.infer<typeof createModelBodySchema>;
export type UpdateModelInput = z.infer<typeof updateModelBodySchema>;
