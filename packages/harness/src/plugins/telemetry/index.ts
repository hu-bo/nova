import type { PluginDefinition } from "../../contracts/plugin.js";
import type { AgentEvent, EventJournal, EventObserver } from "../../contracts/event.js";
import { eventJournal, eventObservers } from "../../contracts/capabilities.js";
import { EventStream } from "../../shared/events.js";
import { positive } from "../../shared/json.js";

export interface TelemetryConfig {
  maxEvents?: number;
  observers?: readonly EventObserver[];
}

/** Provides a bounded, replayable session event journal and safe observers. */
export function telemetryPlugin(config: TelemetryConfig = {}): PluginDefinition<TelemetryConfig> {
  const maxEvents = positive(config.maxEvents ?? 512, "maxEvents");
  const observers = [...(config.observers ?? [])];
  return {
    manifest: {
      id: "nnova.telemetry",
      version: "0.1.0",
      apiVersion: 1,
      scope: "session",
      requires: [],
      provides: [eventJournal],
      contributes: [eventObservers],
    },
    config: { maxEvents },
    setup(context) {
      const stream = new EventStream<AgentEvent>(maxEvents);
      const history: AgentEvent[] = [];
      const journal: EventJournal = {
        publish: (event) => {
          const published: AgentEvent = {
            ...event,
            seq: stream.latestSequence + 1,
          };
          stream.publish(published);
          history.push(structuredClone(published));
          if (history.length > maxEvents) history.shift();
        },
        snapshot: () => structuredClone(history),
        events: (afterSequence = 0) => stream.readFrom(afterSequence),
      };
      context.provide(eventJournal, journal);
      for (const observer of observers) context.contribute(eventObservers, observer);
      context.onDispose(() => {
        stream.close();
        history.length = 0;
      });
    },
  };
}
