import { z } from "zod";

export type CodeChange = {
  path: string;
  oldText: string;
  newText: string;
};

export type DecisionRequest =
  | {
      kind: "approval";
      decisionId: string;
      toolName: string;
      args: unknown;
      risk: "read" | "write" | "exec";
      codeChanges?: CodeChange[] | undefined;
    }
  | {
      kind: "question";
      decisionId: string;
      question: string;
      options: string[];
      multiSelect: boolean;
    };

export type DecisionResponse =
  | { kind: "approval"; decision: "allow" | "deny" | "allow_always"; reason?: string | undefined }
  | { kind: "question"; answers: string[] };

const CodeChangeSchema: z.ZodType<CodeChange> = z.object({
  path: z.string().min(1),
  oldText: z.string(),
  newText: z.string(),
});

export const DecisionRequestSchema: z.ZodType<DecisionRequest> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decisionId: z.string().min(1),
    toolName: z.string().min(1),
    args: z.unknown().refine((value) => value !== undefined, "args is required"),
    risk: z.enum(["read", "write", "exec"]),
    codeChanges: z.array(CodeChangeSchema).optional(),
  }),
  z.object({
    kind: z.literal("question"),
    decisionId: z.string().min(1),
    question: z.string().min(1),
    options: z.array(z.string().min(1)).min(1),
    multiSelect: z.boolean(),
  }),
]);

export const DecisionResponseSchema: z.ZodType<DecisionResponse> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["allow", "deny", "allow_always"]),
    reason: z.string().optional(),
  }),
  z.object({ kind: z.literal("question"), answers: z.array(z.string().min(1)) }),
]);
