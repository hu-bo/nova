import assert from "node:assert/strict";
import { z } from "zod";
import { BUGGY_LINE, FIXED_LINE } from "./coding-workspace.js";
import { toolResult, type ScriptStep } from "./scripted-model.js";

export function repairScript(label: string): ScriptStep[] {
  return [
    { tool: { name: "workspace_list", input: {} } },
    {
      check(request) {
        const value = z
          .object({ files: z.array(z.string()) })
          .parse(toolResult(request, "workspace_list"));
        assert.ok(value.files.includes("src/total.mjs"));
        assert.ok(value.files.includes("test/total.test.mjs"));
      },
      tool: { name: "workspace_read", input: { path: "src/total.mjs" } },
    },
    {
      check(request) {
        const value = z
          .object({ content: z.string() })
          .parse(toolResult(request, "workspace_read"));
        assert.ok(value.content.includes(BUGGY_LINE));
      },
      tool: { name: "tests_run", input: {} },
    },
    {
      check(request) {
        const value = z
          .object({ exitCode: z.number() })
          .parse(toolResult(request, "tests_run"));
        assert.notEqual(value.exitCode, 0, "修复前必须观察到真实测试失败");
      },
      tool: {
        name: "workspace_patch",
        input: { path: "src/total.mjs", before: BUGGY_LINE, after: FIXED_LINE },
      },
    },
    {
      check(request) {
        assert.equal(
          z
            .object({ changed: z.boolean() })
            .parse(toolResult(request, "workspace_patch")).changed,
          true,
        );
      },
      tool: { name: "tests_run", input: {} },
    },
    {
      check(request) {
        assert.equal(
          z
            .object({ exitCode: z.number() })
            .parse(toolResult(request, "tests_run")).exitCode,
          0,
        );
      },
      tool: { name: "workspace_diff", input: {} },
    },
    {
      check(request) {
        const value = z
          .object({ diff: z.string() })
          .parse(toolResult(request, "workspace_diff"));
        assert.ok(value.diff.includes(`-  ${BUGGY_LINE}`));
        assert.ok(value.diff.includes(`+  ${FIXED_LINE}`));
      },
      text: `${label}：已修复总价计算，3 项测试通过，原有 README 修改已保留。`,
    },
  ];
}
