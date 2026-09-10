import { expect, it } from "vitest";
import { createEventHub } from "./event-hub.js";

it("replays within one epoch and rejects cursors from a restarted server", () => {
  const before = createEventHub(2);
  const cursor = before.publish("c", { type: "error", code: "test", message: "first" }).id;
  const next = before.publish("c", { type: "run.end", runId: "r", stopReason: "done" });
  expect(before.replay("c", cursor)).toEqual({ kind: "events", events: [next] });
  const after = createEventHub();
  after.publish("c", { type: "error", code: "test", message: "unrelated" });
  expect(after.replay("c", cursor)).toEqual({ kind: "resync" });
  expect(after.replay("c", "1")).toEqual({ kind: "resync" });
});
