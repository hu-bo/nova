import { z } from "zod";

export const bindingSchema = z.object({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  runnerId: z.string().uuid().nullable(),
  remoteConnectionId: z.string().uuid().nullable().optional(),
  workspaceId: z.string(),
  canonicalCwd: z.string(),
  instructions: z.object({ customPrompt: z.string().optional() }),
});
export const bindProjectBodySchema = z
  .object({
    runnerId: z.string().uuid().optional(),
    remoteConnectionId: z.string().uuid().optional(),
    workspaceId: z.string().min(1).max(256).optional(),
    canonicalCwd: z.string().min(1).max(1024),
    customPrompt: z.string().max(32000).default(""),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (Boolean(input.runnerId) === Boolean(input.remoteConnectionId))
      ctx.addIssue({ code: "custom", path: ["runnerId"], message: "Choose one Runner or SSH connection" });
    if (input.runnerId && !input.workspaceId)
      ctx.addIssue({ code: "custom", path: ["workspaceId"], message: "Runner workspace is required" });
  });

export type BindProjectInput = z.infer<typeof bindProjectBodySchema>;
