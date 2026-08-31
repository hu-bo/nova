import { expect, it } from "vitest";
import { createEventHub } from "../runtime/event-hub.js";
import { createPendingDecisions } from "./pending-decisions.js";

it("publishes decision.resolved when an abort cancels a pending decision", async () => {
  const events = createEventHub();
  const decisions = createPendingDecisions(events);
  const controller = new AbortController();
  const pending = decisions.createDecide("conversation-1", "user-1")(
    { kind: "question", decisionId: "decision-1", question: "Continue?", options: [], multiSelect: false },
    controller.signal,
  );

  controller.abort();
  await expect(pending).rejects.toBeDefined();

  const replay = events.replay("conversation-1", "0");
  expect(replay.kind).toBe("events");
  if (replay.kind === "events")
    expect(replay.events.map((item) => item.event)).toEqual([
      expect.objectContaining({ type: "decision.requested" }),
      { type: "decision.resolved", decisionId: "decision-1" },
    ]);
});
