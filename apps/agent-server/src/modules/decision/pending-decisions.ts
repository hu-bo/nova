import type { Decide, DecisionRequest as CoreDecisionRequest, DecisionResponse } from "@nova/agent-core";
import type { DecisionRequest } from "@nova/protocol";
import { notFound } from "../../errors.js";
import type { EventHub } from "../runtime/event-hub.js";

export interface PendingDecisions {
  createDecide(conversationId: string, userId: string): Decide;
  resolve(decisionId: string, userId: string, response: DecisionResponse): void;
}

type Pending = {
  conversationId: string;
  userId: string;
  resolve(response: DecisionResponse): void;
  reject(reason: unknown): void;
};

export function createPendingDecisions(events: EventHub): PendingDecisions {
  const pending = new Map<string, Pending>();

  return {
    createDecide(conversationId, userId) {
      return (request, signal) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            pending.delete(request.decisionId);
            reject(signal.reason);
          };
          pending.set(request.decisionId, {
            conversationId,
            userId,
            resolve: (response) => {
              signal.removeEventListener("abort", onAbort);
              resolve(response);
            },
            reject,
          });
          events.publish(conversationId, { type: "decision.requested", request: toUiRequest(request) });
          signal.addEventListener("abort", onAbort, { once: true });
        });
    },
    resolve(decisionId, userId, response) {
      const item = pending.get(decisionId);
      if (!item || item.userId !== userId) throw notFound("Decision");
      pending.delete(decisionId);
      item.resolve(response);
      events.publish(item.conversationId, { type: "decision.resolved", decisionId });
    },
  };
}

function toUiRequest(request: CoreDecisionRequest): DecisionRequest {
  if (request.kind === "question") return request;
  if (request.risk === "none") throw new Error("risk-free tools must not request approval");
  return {
    kind: "approval",
    decisionId: request.decisionId,
    toolName: request.toolName,
    args: request.args,
    risk: request.risk,
  };
}
