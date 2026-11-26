import { z } from "zod";

export const productIdPrefixes = { conversation: "cv_", run: "rn_", pendingInput: "pi_" } as const;
export const productIdBytes = 12;

function productIdSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}[A-Za-z0-9_-]{${(productIdBytes * 8) / 6}}$`));
}

export const conversationIdSchema = productIdSchema(productIdPrefixes.conversation);
export const runIdSchema = productIdSchema(productIdPrefixes.run);
export const pendingInputIdSchema = productIdSchema(productIdPrefixes.pendingInput);
