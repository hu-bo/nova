export { startConversationExecution } from "./execution-host.js";
import type { FastifyInstance } from "fastify";
import { registerRunRoutes } from "./run.routes.js";

// 实际路径 /api/runs/... 和 /api/decisions/...; 由 app.ts 在 /api 前缀下挂载.
export async function runsModule(app: FastifyInstance): Promise<void> {
  await app.register(registerRunRoutes, { prefix: "" });
}

// Conversation commands participate in the same aggregate transaction as runs.
export {
  runJournal,
  type RunJournal,
  conversationView,
  effectiveCapabilities,
  emptyProjection,
  fingerprint,
  inputReceipt,
  messageDTO,
  publicInteraction,
  queuedInput,
} from "./run.repository.js";
export { runtimeAdapters } from "./runtime-adapter.js";
export { runProjectionReader } from "./run-projection.repository.js";
