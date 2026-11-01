import { z } from "zod";
import { idSchema, jsonValueSchema } from "./messages.js";
const base = z.object({
  id: idSchema,
  revision: z.number().int().positive(),
  state: z.enum(["pending", "resolved", "expired", "cancelled"]),
  expiresAt: z.iso.datetime().optional(),
  callId: idSchema.optional(),
});
export const interactionSchema = z.discriminatedUnion("kind", [
  base
    .extend({
      kind: z.literal("approval"),
      toolName: z.string(),
      args: jsonValueSchema,
      risk: z.enum(["read", "write", "exec"]),
      allowedScopes: z.array(z.enum(["once", "session"])).min(1),
      codeChanges: z
        .array(z.object({ path: z.string(), oldText: z.string(), newText: z.string() }).strict())
        .optional(),
    })
    .strict(),
  base
    .extend({
      kind: z.literal("question"),
      question: z.string().min(1),
      options: z
        .array(z.object({ id: idSchema, label: z.string().min(1) }).strict())
        .refine(
          (options) => new Set(options.map((option) => option.id)).size === options.length,
          "Duplicate option ID",
        ),
      multiSelect: z.boolean(),
      allowCustom: z.boolean(),
    })
    .strict(),
]);
export const interactionResponseSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("approval"), decision: z.enum(["allow", "deny"]), scope: z.enum(["once", "session"]) })
    .strict(),
  z
    .object({
      kind: z.literal("question"),
      optionIds: z.array(idSchema).max(64),
      customText: z.string().trim().min(1).max(8000).optional(),
    })
    .strict(),
]);
export type Interaction = z.infer<typeof interactionSchema>;
export type InteractionResponse = z.infer<typeof interactionResponseSchema>;
export function validInteractionResponse(interaction: Interaction, response: InteractionResponse): boolean {
  if (interaction.kind !== response.kind) return false;
  if (interaction.kind === "approval" && response.kind === "approval")
    return interaction.allowedScopes.includes(response.scope);
  if (interaction.kind === "question" && response.kind === "question")
    return (
      new Set(response.optionIds).size === response.optionIds.length &&
      response.optionIds.every((id) => interaction.options.some((option) => option.id === id)) &&
      (interaction.multiSelect || response.optionIds.length <= 1) &&
      (!response.customText || interaction.allowCustom) &&
      (response.optionIds.length > 0 || Boolean(response.customText))
    );
  return false;
}
