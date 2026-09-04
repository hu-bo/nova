import { expect, it } from "vitest";
import { codingAgentModule, createRunnerEnvironmentPrompt } from "./index.js";

it("owns the single Coding prompt and the Coding tools", () => {
  expect(codingAgentModule.id).toBe("nova.coding-agent");
  expect(codingAgentModule.prompts?.map((prompt) => prompt.name)).toEqual(["coding-workflow"]);
  expect(codingAgentModule.tools?.map((tool) => tool.name)).toEqual([
    "read_file",
    "read_document",
    "read_url",
    "grep",
    "list_dir",
    "git_diff",
    "write_file",
    "edit_file",
    "bash",
    "todo_write",
  ]);
  expect(new Set(codingAgentModule.tools?.map((tool) => tool.name)).size).toBe(10);
});

it("describes the bound Windows runner without implying a Unix shell", () => {
  const prompt = createRunnerEnvironmentPrompt({
    platform: "windows-x86_64",
    workspace: "E:\\work\\nova",
  });

  expect(prompt.name).toBe("runner-environment");
  expect(prompt.content).toContain('Platform: "windows-x86_64"');
  expect(prompt.content).toContain('Working directory: "E:\\\\work\\\\nova"');
  expect(prompt.content).toContain("直接启动 command，不经过 shell 解析");
  expect(prompt.content).toContain("不要默认使用 ls、cat、grep、rm 等 Unix 命令");
  expect(prompt.content).toContain("powershell.exe");
});
