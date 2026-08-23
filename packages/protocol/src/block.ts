import { z } from "zod";

export type ToolStatus = "running" | "ok" | "error" | "cancelled";

export interface Todo {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  note?: string | undefined;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "code"; language: string; code: string; path?: string | undefined; startLine?: number | undefined }
  | { type: "diff"; path: string; diff: string; added: number; removed: number }
  | { type: "file"; path: string; kind: "file" | "dir"; size?: number | undefined }
  | { type: "tool_call"; callId: string; name: string; args: unknown; status: ToolStatus }
  | { type: "tool_result"; callId: string; status: "ok" | "error"; blocks: Block[] }
  | { type: "todo"; items: Todo[] }
  | { type: "error"; code: string; message: string };

export const ToolStatusSchema = z.enum(["running", "ok", "error", "cancelled"]);

export const TodoSchema: z.ZodType<Todo> = z.object({
  id: z.string().min(1),
  text: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "blocked"]),
  note: z.string().optional(),
});

export const BlockSchema: z.ZodType<Block> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("thinking"), text: z.string() }),
    z.object({
      type: z.literal("code"),
      language: z.string(),
      code: z.string(),
      path: z.string().optional(),
      startLine: z.number().int().positive().optional(),
    }),
    z.object({
      type: z.literal("diff"),
      path: z.string(),
      diff: z.string(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
    z.object({
      type: z.literal("file"),
      path: z.string(),
      kind: z.enum(["file", "dir"]),
      size: z.number().int().nonnegative().optional(),
    }),
    z.object({
      type: z.literal("tool_call"),
      callId: z.string().min(1),
      name: z.string().min(1),
      args: z.unknown().refine(value => value !== undefined, "args is required"),
      status: ToolStatusSchema,
    }),
    z.object({
      type: z.literal("tool_result"),
      callId: z.string().min(1),
      status: z.enum(["ok", "error"]),
      blocks: z.array(BlockSchema),
    }),
    z.object({ type: z.literal("todo"), items: z.array(TodoSchema) }),
    z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
  ]),
);
