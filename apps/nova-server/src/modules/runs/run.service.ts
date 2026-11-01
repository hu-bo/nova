import type { Database } from "../../../database/index.js";
import { createScope, defineService } from "../../shared/scope.js";
import { runRepository, type RunRepository } from "./run.repository.js";

/** One fenced database transition per transaction; runtime/provider work stays outside. */
export const runService = defineService({ repository: runRepository }, ({ repository, transaction }) => ({
  state: (...args: Parameters<RunRepository["state"]>) => repository.state(...args),
  watch: (...args: Parameters<RunRepository["watch"]>) => repository.watch(...args),
  sessionRevision: (...args: Parameters<RunRepository["sessionRevision"]>) => repository.sessionRevision(...args),
  heartbeat: (...args: Parameters<RunRepository["heartbeat"]>) => repository.heartbeat(...args),
  load: (...args: Parameters<RunRepository["load"]>) =>
    transaction(({ repository }) => repository.load(...args), { isolationLevel: "repeatable read" }),
  recover: () => repository.recover(),
  prepare: (...args: Parameters<RunRepository["prepare"]>) =>
    transaction(({ repository }) => repository.prepare(...args)),
  pinModel: (...args: Parameters<RunRepository["pinModel"]>) =>
    transaction(({ repository }) => repository.pinModel(...args)),
  releaseForRecovery: (...args: Parameters<RunRepository["releaseForRecovery"]>) =>
    transaction(({ repository }) => repository.releaseForRecovery(...args)),
  commit: (...args: Parameters<RunRepository["commit"]>) => transaction(({ repository }) => repository.commit(...args)),
  commitSession: (...args: Parameters<RunRepository["commitSession"]>) =>
    transaction(({ repository }) => repository.commitSession(...args)),
  publish: (...args: Parameters<RunRepository["publish"]>) =>
    transaction(({ repository }) => repository.publish(...args)),
  publishNativeEvents: (...args: Parameters<RunRepository["publishNativeEvents"]>) =>
    transaction(({ repository }) => repository.publishNativeEvents(...args)),
  reserveSteering: (...args: Parameters<RunRepository["reserveSteering"]>) =>
    transaction(({ repository }) => repository.reserveSteering(...args)),
  requestInteraction: (...args: Parameters<RunRepository["requestInteraction"]>) =>
    transaction(({ repository }) => repository.requestInteraction(...args)),
  respond: (...args: Parameters<RunRepository["respond"]>) =>
    transaction(({ repository }) => repository.respond(...args)),
  suspend: (...args: Parameters<RunRepository["suspend"]>) =>
    transaction(({ repository }) => repository.suspend(...args)),
  cancel: (...args: Parameters<RunRepository["cancel"]>) => transaction(({ repository }) => repository.cancel(...args)),
  finish: (...args: Parameters<RunRepository["finish"]>) => transaction(({ repository }) => repository.finish(...args)),
  goalIteration: (...args: Parameters<RunRepository["goalIteration"]>) =>
    transaction(({ repository }) => repository.goalIteration(...args)),
  replacePlan: (...args: Parameters<RunRepository["replacePlan"]>) =>
    transaction(({ repository }) => repository.replacePlan(...args)),
}));

export function createRunService(db: Database) {
  return createScope(db).get(runService);
}
export type RunService = ReturnType<typeof createRunService>;
