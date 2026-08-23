import { expect, it } from "vitest";
import { codingAgentModule } from "./index.js";

it("owns the single Coding prompt and the Coding tools", () => {
  expect(codingAgentModule.id).toBe("nova.coding-agent");
  expect(codingAgentModule.prompts?.map(prompt => prompt.name)).toEqual(["coding-workflow"]);
  expect(codingAgentModule.tools?.map(tool => tool.name)).toEqual([
    "read_file", "read_url", "grep", "list_dir", "git_diff", "write_file", "edit_file", "bash", "todo_write",
  ]);
  expect(new Set(codingAgentModule.tools?.map(tool => tool.name)).size).toBe(9);
});
