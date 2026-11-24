import assert from "node:assert/strict";
import test from "node:test";
import {
  applyEvent,
  artifactStateSchema,
  artifactSummarySchema,
  type ArtifactSummary,
  type ProductEvent,
  type Snapshot,
} from "../src/index.js";

const artifact: ArtifactSummary = {
  id: "artifact-1",
  runId: "run-1",
  skillVersionId: "skill-version-1",
  name: "test-report.md",
  mimeType: "text/markdown",
  size: 2048,
  sha256: "a".repeat(64),
  state: "publishing",
  preview: "markdown",
  runState: "succeeded",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const snapshot: Snapshot = {
  conversation: { id: "c1", title: null, mode: "chat", projectId: null, epoch: 1, configuration: { backendId: "nova", modelId: null, mode: "build" } },
  cursor: "0",
  messages: [],
  beforeSequence: null,
  run: null,
  operations: [],
  interactions: [],
  pendingInputs: [],
  artifacts: [artifact],
  capabilities: { tools: true, approval: true, question: true, steering: true, resume: true, compact: false, images: true, files: true },
};

function event(sequence: string, payload: { artifactId: string; runId: string; state: "publishing" | "ready" | "failed" }): ProductEvent {
  return { sequence, runId: payload.runId, type: "artifact.changed", payload } as unknown as ProductEvent;
}

test("artifact state enum and summary validate the three publishing states", () => {
  assert.deepEqual(artifactStateSchema.options, ["publishing", "ready", "failed"]);
  assert.ok(artifactSummarySchema.safeParse(artifact).success);
  assert.equal(artifactSummarySchema.safeParse({ ...artifact, preview: "html" }).success, false);
});

test("artifact.changed updates a loaded artifact and ignores unknown ones without dropping the list", () => {
  let state = snapshot;
  const ready = applyEvent(state, event("1", { artifactId: "artifact-1", runId: "run-1", state: "ready" }));
  assert.equal(ready.artifacts?.[0]?.state, "ready");
  state = ready;
  const failed = applyEvent(state, event("2", { artifactId: "artifact-1", runId: "run-1", state: "failed" }));
  assert.equal(failed.artifacts?.[0]?.state, "failed");
  // 未加载的产物：事件只作失效信号，列表保持不变（客户端刷新 GET /conversations/:id/artifacts）。
  const unknown = applyEvent(failed, event("3", { artifactId: "artifact-9", runId: "run-9", state: "ready" }));
  assert.equal(unknown.artifacts?.length, 1);
  assert.equal(unknown.artifacts?.[0]?.state, "failed");
});
