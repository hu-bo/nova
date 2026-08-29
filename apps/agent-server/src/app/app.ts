import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { createDailyFileStream, createLogger } from "@nova/logger";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AgentStore } from "../store.js";
import type { VerifyAccessToken } from "./plugins/auth.js";
import { registerAuth } from "./plugins/auth.js";
import { registerErrorHandler } from "./plugins/error-handler.js";
import { registerOpenApi } from "./plugins/openapi.js";
import type { EventHub } from "../modules/runtime/event-hub.js";
import type { PendingDecisions } from "../modules/decision/pending-decisions.js";
import type { RunnerRegistry } from "../modules/runner/registry.js";
import type { ConversationRuntimes } from "../modules/runtime/runtime-registry.js";
import type { AuthServiceClient } from "./auth-service.js";
import { authRoutes } from "../modules/auth/auth.route.js";
import { projectRoutes } from "../modules/project/project.route.js";
import { conversationRoutes } from "../modules/conversation/conversation.route.js";
import { conversationEventRoutes, messageRoutes } from "../modules/messages/messages.route.js";
import { decisionRoutes } from "../modules/decision/decision.route.js";
import { userRoutes } from "../modules/user/user.route.js";
import { runnerRoutes } from "../modules/runner/runner.route.js";
import type { ModelConfigStore } from "../modules/model-config/model-config.store.js";
import type { CredentialCipher } from "../modules/model-config/credential.js";
import { providerRoutes } from "../modules/model-config/provider.route.js";
import { modelRoutes } from "../modules/model-config/model.route.js";
import { quotaRoutes } from "../modules/model-config/quota.route.js";
import { usageRoutes } from "../modules/model-config/usage.route.js";
import { availableModelRoutes } from "../modules/model-config/available-model.route.js";
import { uploadRoutes } from "../modules/uploads/upload.route.js";
import type { UploadStorage } from "../modules/uploads/upload-storage.js";

export interface AppDependencies {
  store: AgentStore;
  verifyAccessToken: VerifyAccessToken;
  events: EventHub;
  decisions: PendingDecisions;
  runners: RunnerRegistry;
  runtimes: ConversationRuntimes;
  authService: AuthServiceClient;
  runnerEndpoint: string;
  modelConfigStore: ModelConfigStore;
  credentialCipher: CredentialCipher;
  uploadStorage?: UploadStorage;
}

export function createApp(logger = true): FastifyInstance {
  const base = {
    requestIdHeader: "x-request-id",
    genReqId: (request: IncomingMessage) => request.headers["x-request-id"]?.toString() ?? crypto.randomUUID(),
    // Access logs are high-volume noise; application warnings and errors are logged explicitly.
    logController: new LogController({ disableRequestLogging: true }),
  };
  if (!logger) return Fastify({ ...base, logger: false });
  const options = {
    redact: ["req.headers.authorization", "body.modelConfig.credential", "body.credential"],
    serializers: {
      req(value: { method?: string; url?: string; ip?: string; raw?: IncomingMessage }) {
        return {
          method: value.method ?? value.raw?.method,
          url: value.url ?? value.raw?.url,
          remoteAddress: value.ip ?? value.raw?.socket.remoteAddress,
        };
      },
      res(value: { statusCode?: number; raw?: { statusCode?: number } }) {
        return { statusCode: value.statusCode ?? value.raw?.statusCode };
      },
      err: pino.stdSerializers.err,
    },
  };
  const file = createDailyFileStream(fileURLToPath(new URL("../../logs/", import.meta.url)));
  const loggerInstance: FastifyBaseLogger = createLogger("agent-server", {
    ...options,
    stream: pino.multistream([{ stream: process.stdout }, { stream: file }]),
  });
  const app = Fastify({
    ...base,
    loggerInstance,
  });
  app.addHook("onClose", async () => file.close());
  return app;
}

export async function registerApp(app: FastifyInstance, dependencies: AppDependencies): Promise<void> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  await registerOpenApi(app);

  await app.register(
    async (api) => {
      authRoutes(api, dependencies.authService);
      conversationEventRoutes(api, dependencies.events);
    },
    { prefix: "/api" },
  );

  await app.register(
    async (admin) => {
      registerAuth(admin, dependencies.verifyAccessToken, dependencies.store);
      providerRoutes(admin, dependencies.modelConfigStore, dependencies.credentialCipher);
      modelRoutes(admin, dependencies.modelConfigStore);
      quotaRoutes(admin, dependencies.modelConfigStore);
      usageRoutes(admin, dependencies.modelConfigStore);
    },
    { prefix: "/admin/model-config" },
  );

  await app.register(
    async (api) => {
      registerAuth(api, dependencies.verifyAccessToken, dependencies.store);
      userRoutes(api);
      runnerRoutes(api, dependencies.store, dependencies.runners, dependencies.runnerEndpoint);
      availableModelRoutes(api, dependencies.modelConfigStore);
      projectRoutes(api, dependencies.store, dependencies.runners);
      conversationRoutes(
        api,
        dependencies.store,
        dependencies.runners,
        dependencies.runtimes,
        dependencies.modelConfigStore,
        dependencies.credentialCipher,
      );
      messageRoutes(
        api,
        dependencies.store,
        dependencies.runtimes,
        dependencies.modelConfigStore,
        dependencies.credentialCipher,
      );
      decisionRoutes(api, dependencies.decisions);
      if (dependencies.uploadStorage) await uploadRoutes(api, dependencies.uploadStorage, dependencies.runners);
      api.get(
        "/openapi.json",
        {
          schema: { hide: true },
        },
        () => api.swagger(),
      );
    },
    { prefix: "/api" },
  );

  await app.ready();
}

export async function buildApp(dependencies: AppDependencies, logger = true): Promise<FastifyInstance> {
  const app = createApp(logger);
  await registerApp(app, dependencies);
  return app;
}
