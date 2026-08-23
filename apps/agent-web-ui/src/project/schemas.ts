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

export const newConversationSchema = z.object({
  mode: z.enum(["chat", "project"]),
  title: z.string().trim().max(100, "最多 100 个字符"),
  modelProfileId: z.string().min(1, "请选择模型配置"),
  runnerId: z.string().trim(),
  projectId: z.string(),
  projectName: z.string().trim().max(80, "最多 80 个字符"),
  workspace: z.string().trim(),
}).superRefine((value, context) => {
  if (value.mode === "chat" && !value.runnerId) {
    context.addIssue({ code: "custom", path: ["runnerId"], message: "请选择 Runner" });
  }
  if (value.mode !== "project") return;
  if (!value.projectId) context.addIssue({ code: "custom", path: ["projectId"], message: "请选择项目" });
  if (value.projectId === "new") {
    if (!value.projectName) context.addIssue({ code: "custom", path: ["projectName"], message: "请输入项目名称" });
    if (!value.runnerId) context.addIssue({ code: "custom", path: ["runnerId"], message: "请选择 Runner" });
    if (!value.workspace) context.addIssue({ code: "custom", path: ["workspace"], message: "请选择 workspace" });
  }
});

export type NewProjectForm = z.infer<typeof newProjectSchema>;
export type BindWorkspaceForm = z.infer<typeof bindWorkspaceSchema>;
export type RenameProjectForm = z.infer<typeof renameProjectSchema>;
export type NewConversationForm = z.infer<typeof newConversationSchema>;
