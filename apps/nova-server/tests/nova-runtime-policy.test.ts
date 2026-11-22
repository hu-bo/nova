import assert from "node:assert/strict";
import test from "node:test";
import { remoteToolDefinitions } from "@nova/tools";
import { buildSystemInstructions, toolModeDecision } from "../src/modules/runs/nova-runtime.js";

test("safe whitelist: read-effect tools are allowed in every execution mode", () => {
  for (const mode of ["build", "plan", "auto"] as const)
    assert.equal(toolModeDecision(mode, "read"), "allow");
});

test("whitelist members are exactly the read-only workspace tools, including git_diff", () => {
  const readTools = remoteToolDefinitions
    .filter((tool) => tool.effects === "read")
    .map((tool) => tool.name);
  assert.deepEqual(readTools, ["list_dir", "read_file", "grep", "git_diff"]);
});

test("write and exec tools: denied in plan, user-confirmed in build, pre-approved in auto", () => {
  for (const effects of ["write", "external-job"] as const) {
    assert.equal(toolModeDecision("plan", effects), "deny");
    assert.equal(toolModeDecision("build", effects), "ask");
    assert.equal(toolModeDecision("auto", effects), "allow");
  }
  assert.equal(toolModeDecision("build", undefined), "deny");
  assert.equal(toolModeDecision("auto", undefined), "deny");
});

test("auto mode instruction tells the agent execution is unattended", () => {
  const instructions = buildSystemInstructions({
    mode: "auto",
    runnerInstructions: undefined,
    projectInstructions: "",
    specExecution: undefined,
    goal: null,
    hasWorkspace: false,
    workspace: ".",
  });
  assert.match(instructions, /AUTO MODE: unattended execution/);
});
