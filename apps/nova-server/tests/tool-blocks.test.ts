import assert from "node:assert/strict";
import test from "node:test";
import { projectToolContent } from "../src/modules/runs/tool-blocks.js";

test("unwraps the success envelope to its content text", () => {
  const blocks = projectToolContent("list_dir", {
    status: "ok",
    content: "Cargo.toml\nREADME.md",
    details: { path: ".", entries: [{ path: "Cargo.toml", kind: "file", sizeBytes: 980 }] },
  });
  assert.deepEqual(blocks, [{ id: "content", type: "text", text: "Cargo.toml\nREADME.md" }]);
});

test("projects read_file details as a code block", () => {
  const blocks = projectToolContent("read_file", {
    status: "ok",
    content: "1: # demo",
    details: { path: "README.md", text: "# demo", startLine: 1 },
  });
  assert.deepEqual(blocks, [{ id: "content", type: "code", language: "markdown", code: "# demo", path: "README.md" }]);
});

test("splits bash stdout and stderr into code and error blocks", () => {
  const blocks = projectToolContent("bash", {
    status: "error",
    content: "out\nerr",
    details: { exitCode: 1, stdout: "out", stderr: "err" },
  });
  assert.deepEqual(blocks, [
    { id: "content:stdout", type: "code", language: "text", code: "out" },
    { id: "content:stderr", type: "error", error: { code: "STDERR", message: "err" } },
  ]);
});

test("projects runtime failures as error blocks", () => {
  const blocks = projectToolContent("read_file", {
    error: { code: "NOT_FOUND", message: "File not found" },
    outcome: "known",
  });
  assert.deepEqual(blocks, [{ id: "content", type: "error", error: { code: "NOT_FOUND", message: "File not found" } }]);
});

test("truncates oversized output", () => {
  const blocks = projectToolContent("grep", { status: "ok", content: "x".repeat(20_000), details: null });
  const [block] = blocks;
  assert.ok(block?.type === "text");
  assert.ok(block.text.length < 20_000);
  assert.match(block.text, /… 已省略 8000 个字符$/);
});

test("falls back to JSON text for custom outputs", () => {
  const blocks = projectToolContent("inspect", { done: true });
  assert.deepEqual(blocks, [{ id: "content", type: "text", text: '{\n  "done": true\n}' }]);
});
