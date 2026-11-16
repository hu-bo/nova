import { z } from "zod";

export const skillSelectionSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export const productSkillSchema = skillSelectionSchema
  .extend({
    name: z.string(),
    description: z.string(),
    source: z.literal("builtin"),
  })
  .strict();
export const agentProfileSchema = z
  .object({
    id: z.literal("chat"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
  })
  .strict();
export const CHAT_AGENT_PROFILE = { id: "chat", version: "1.0.0" } as const;
export type SkillSelection = z.infer<typeof skillSelectionSchema>;
export type ProductSkill = z.infer<typeof productSkillSchema>;
