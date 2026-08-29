import { createApp, registerApp } from "./app/app.js";
import { createAuthServiceClient } from "./app/auth-service.js";
import { loadConfig } from "./app/config.js";
import { createPgStore } from "./db/pg-store.js";
import { pgSessionStorage } from "./db/pg-session-storage.js";
import { createPendingDecisions } from "./modules/decision/pending-decisions.js";
import { projectAgentEvents } from "./modules/projection/project-agent-events.js";
import { createRunnerRegistry } from "./modules/runner/registry.js";
import { createAgentRuntime } from "./modules/runtime/create-agent-runtime.js";
import { createEventHub } from "./modules/runtime/event-hub.js";
import { createRuntimeRegistry } from "./modules/runtime/runtime-registry.js";
import { createRunnerSdk } from "@nova/runner-sdk";
import { createCredentialCipher } from "./modules/model-config/credential.js";
import { createPgModelConfigStore } from "./modules/model-config/model-config.store.js";
import { createMinioUploadStorage } from "./modules/uploads/upload-storage.js";
import { createLogger } from "@nova/logger";

const logger = createLogger("agent-server").child("server");

const app = createApp();
const config = await loadConfig(app);
const authService = createAuthServiceClient(config.AUTH_SERVICE_URL);
const database = createPgStore(config.DATABASE_URL);
const modelConfigStore = createPgModelConfigStore(database.db);
const credentialCipher = createCredentialCipher(config.MODEL_CONFIG_ENCRYPTION_KEY);
const uploadStorage = createMinioUploadStorage({
  endPoint: config.MINIO_ENDPOINT,
  port: config.MINIO_PORT,
  useSSL: config.MINIO_USE_SSL,
  accessKey: config.MINIO_ACCESS_KEY,
  secretKey: config.MINIO_SECRET_KEY,
  bucket: config.MINIO_BUCKET,
});
try {
  await database.checkConnection();
} catch (error) {
  await database.close();
  logger.fatal({ err: error, component: "server" }, "database connection failed during startup");
  throw new Error(`Unable to connect to PostgreSQL. Check DATABASE_URL and ensure PostgreSQL is running.`, {
    cause: error,
  });
}
const events = createEventHub();
const runners = createRunnerRegistry(database.store);
const runnerSdk = createRunnerSdk({ host: config.RUNNER_HOST, port: config.RUNNER_PORT });
runnerSdk.onSession((candidate) => {
  void (async () => {
    const token = await database.store.findRunnerToken(candidate.token);
    if (!token) {
      logger.warn(
        { component: "server", dependency: "runner", runnerId: candidate.identity.runnerId },
        "runner registration rejected: invalid token",
      );
      await candidate.reject("UNAUTHORIZED", "runner token is invalid");
      return;
    }
    const session = candidate.accept();
    try {
      await runners.register(token.userId, token.id, session);
    } catch (error) {
      logger.error(
        { err: error, component: "server", runnerId: candidate.identity.runnerId },
        "runner registration failed",
      );
    }
  })().catch((error) => {
    logger.error({ err: error, component: "server", runnerId: candidate.identity.runnerId }, "runner admission failed");
    void candidate.reject("INTERNAL", "runner admission failed");
  });
});
await runnerSdk.listen();
logger.info(
  {
    component: "server",
    dependency: "runner",
    listenEndpoint: runnerSdk.endpoint,
    publicEndpoint: config.RUNNER_PUBLIC_URL,
  },
  "runner gRPC listener started",
);
const decisions = createPendingDecisions(events);
const runtimes = createRuntimeRegistry(
  (route) =>
    createAgentRuntime(route, {
      storage: (conversationId) => pgSessionStorage(database.db, conversationId),
      decisions,
      runners,
    }),
  (conversationId, agent) => agent.subscribe(projectAgentEvents(conversationId, events, database.store)),
  (failure) => {
    logger.error(
      {
        component: "agent-core",
        ...(failure.error ? { err: failure.error } : {}),
        conversationId: failure.conversationId,
        ...(failure.runId ? { runId: failure.runId } : {}),
        provider: failure.provider,
        model: failure.model,
        endpointHost: failure.endpointHost,
        errorMessage: failure.message,
      },
      "conversation run failed",
    );
  },
);
await registerApp(app, {
  store: database.store,
  events,
  runners,
  decisions,
  runtimes,
  authService,
  runnerEndpoint: config.RUNNER_PUBLIC_URL,
  verifyAccessToken: authService.verifyAccessToken,
  modelConfigStore,
  credentialCipher,
  uploadStorage,
});

const close = async () => {
  await app.close();
  await runnerSdk.close();
  await database.close();
};
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

await app.listen({ host: config.HOST, port: config.PORT });
logger.info({ host: config.HOST, port: config.PORT }, "agent server started");
