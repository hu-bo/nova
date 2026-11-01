import Fastify from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import { attachmentsModule } from "./modules/attachments/index.js";
import { clientConfigModule } from "./modules/client-config/index.js";
import {
  conversationsModule,
  createConversationReader,
  createConversationEventHeads,
} from "./modules/conversations/index.js";
import { eventsModule, createEventRetentionService } from "./modules/events/index.js";
import { healthModule } from "./modules/health/index.js";
import { identityPlugin } from "./modules/identity/index.js";
import { projectsModule } from "./modules/projects/index.js";
import { registerRunnerConnections, runnersModule } from "./modules/runners/index.js";
import { startConversationExecution, runsModule } from "./modules/runs/index.js";
import { modelConfigAdminModule, userModelProfilesModule } from "./modules/model-config/index.js";
import { remotesModule } from "./modules/remotes/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import { errorResponseSchema } from "./shared/error.schema.js";
import { createLoggerOptions } from "./shared/logger.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Pick<AppConfig, "SSE_HEARTBEAT_MS" | "SSE_QUEUE_FRAMES" | "SSE_QUEUE_BYTES">;
    credentialEncryptionKey: string | undefined;
  }
}

export async function buildApp(config: AppConfig, options: { exportMode?: boolean } = {}) {
  const app = Fastify({
    logger: createLoggerOptions(config.LOG_LEVEL),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandlers(app);
  app.addHook("onRoute", (route) => {
    if (route.schema) {
      const response = route.schema.response;
      route.schema.response = {
        default: errorResponseSchema,
        ...(response && typeof response === "object" ? response : {}),
      };
    }
  });
  // 将与运行时共享的同构配置挂在 fastify instance 上, 供 transport 层(如 SSE)
  // 在不重新解析 env 的前提下读取; 仅暴露必要子集, 避免泄漏凭证字段。
  app.decorate("config", {
    SSE_HEARTBEAT_MS: config.SSE_HEARTBEAT_MS,
    SSE_QUEUE_FRAMES: config.SSE_QUEUE_FRAMES,
    SSE_QUEUE_BYTES: config.SSE_QUEUE_BYTES,
  });
  app.decorate("credentialEncryptionKey", config.MODEL_CONFIG_ENCRYPTION_KEY);
  app.decorate("executionEnabled", !options.exportMode);
  try {
    await registerOpenApi(app, config.SWAGGER_UI_ENABLED && !options.exportMode);
    await app.register(databasePlugin, {
      DATABASE_URL: config.DATABASE_URL,
      DATABASE_POOL_MAX: config.DATABASE_POOL_MAX,
      DATABASE_CONNECT_TIMEOUT_MS: config.DATABASE_CONNECT_TIMEOUT_MS,
      DATABASE_QUERY_TIMEOUT_MS: config.DATABASE_QUERY_TIMEOUT_MS,
      ...(options.exportMode !== undefined ? { exportMode: options.exportMode } : {}),
    });
    await app.register(identityPlugin, {
      AUTH_MODE: config.AUTH_MODE,
      AUTH_SERVICE_URL: config.AUTH_SERVICE_URL,
      AUTH_SERVICE_TOKEN_TRANSPORT: config.AUTH_SERVICE_TOKEN_TRANSPORT,
      AUTH_SERVICE_TIMEOUT_MS: config.AUTH_SERVICE_TIMEOUT_MS,
    });
    await registerRunnerConnections(app, Boolean(options.exportMode));
    if (!options.exportMode && (config.ROLE === "all" || config.ROLE === "worker"))
      startConversationExecution(
        app,
        config,
        createEventRetentionService(app.db, createConversationEventHeads(app.db)),
      );
    if (config.ROLE !== "worker") {
      await app.register(healthModule);
      await app.register(projectsModule, { prefix: "/api" });
      await app.register(conversationsModule, { prefix: "/api" });
      await app.register(attachmentsModule, { prefix: "/api" });
      await app.register(runnersModule, { prefix: "/api" });
      await app.register(remotesModule, { prefix: "/api" });
      await app.register(eventsModule, { prefix: "/api", conversations: createConversationReader(app.db) });
      await app.register(runsModule, { prefix: "/api" });
      await app.register(clientConfigModule, { prefix: "/api" });
      await app.register(userModelProfilesModule, { prefix: "/api" });
      await app.register(modelConfigAdminModule, {
        prefix: "/admin",
        ...(config.MODEL_CONFIG_ENCRYPTION_KEY ? { encryptionKey: config.MODEL_CONFIG_ENCRYPTION_KEY } : {}),
      });
    }
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
