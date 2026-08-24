import { z } from "zod";

export const newProjectSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称").max(80, "最多 80 个字符"),
  runnerId: z.string().trim().min(1, "请选择 Runner"),
  workspace: z.string().trim().min(1, "请选择 workspace"),
});

export const bindWorkspaceSchema = z.object({
  runnerId: z.string().trim().min(1, "请选择 Runner"),
  workspace: z.string().trim().min(1, "请选择 workspace"),
});

export const renameProjectSchema = z.object({
  name: z.string().trim().min(1, "请输入项目名称").max(80, "最多 80 个字符"),
});

export type NewProjectForm = z.infer<typeof newProjectSchema>;
export type BindWorkspaceForm = z.infer<typeof bindWorkspaceSchema>;
export type RenameProjectForm = z.infer<typeof renameProjectSchema>;
