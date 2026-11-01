import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decodeExecutionEvent, encodeExecutionEvent } from "../src/index.ts";

const fixtureHex = readFileSync(
  new URL("../../../proto/runner/v1/fixtures/execution-event.hex", import.meta.url),
  "utf8",
).trim();
const fixture = Buffer.from(fixtureHex, "hex");

test("ExecutionEvent matches the shared Rust and TypeScript fixture", () => {
  const encoded = encodeExecutionEvent({
    executionId: "fixture-execution",
    sequence: "9007199254740993",
    output: { stream: "STDOUT", data: new Uint8Array([0, 255, 226, 130]) },
  });

  assert.equal(Buffer.from(encoded).toString("hex"), fixtureHex);
});

test("ExecutionEvent decode preserves uint64 sequence and raw output bytes", () => {
  const event = decodeExecutionEvent(fixture);

  assert.equal(event.executionId, "fixture-execution");
  assert.equal(event.sequence, "9007199254740993");
  assert.equal(event.event, "output");
  assert.deepEqual([...event.output.data], [0, 255, 226, 130]);
  assert.equal(event.output.stream, "STDOUT");
});

test("ExecutionEvent decode ignores unknown protobuf fields", () => {
  const withUnknownField = Buffer.concat([fixture, Buffer.from("9a0603616263", "hex")]);

  const event = decodeExecutionEvent(withUnknownField);

  assert.equal(event.sequence, "9007199254740993");
  assert.deepEqual([...event.output.data], [0, 255, 226, 130]);
});
