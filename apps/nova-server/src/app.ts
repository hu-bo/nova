import Fastify, { LogController } from "fastify";
import type { FastifyRequest } from "fastify";
import { serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import type { AppConfig } from "./config.js";
import { attachmentsModule } from "./modules/attachments/index.js";
import { createMinioUploadStorage, disabledUploadStorage } from "./modules/attachments/upload-storage.js";
import {
  artifactsModule,
  createArtifactService,
  createMinioArtifactStorage,
  disabledArtifactStorage,
} from "./modules/artifacts/index.js";
import { clientConfigModule } from "./modules/client-config/index.js";
import {
  conversationsModule,
  createConversationReader,
  createConversationEventHeads,
} from "./modules/conversations/index.js";
import { eventsModule, createEventRetentionService } from "./modules/events/index.js";
import { healthModule } from "./modules/health/index.js";
import { identityPlugin } from "./modules/identity/index.js";
import { createProjectBindingService, projectsModule } from "./modules/projects/index.js";
import {
  createRunnerReader,
  registerRunnerConnections,
  runnersModule,
  RunnerLocalResources,
} from "./modules/runners/index.js";
import { startConversationExecution, runsModule } from "./modules/runs/index.js";
import { createUserModelProfilesService, modelConfigAdminModule, userModelProfilesModule } from "./modules/model-config/index.js";
import { remotesModule } from "./modules/remotes/index.js";
import { specsModule } from "./modules/specs/index.js";
import { skillsModule, SkillService, createSkillRepository } from "./modules/skills/index.js";
import { databasePlugin } from "./plugins/database.js";
import { registerErrorHandlers } from "./plugins/errors.js";
import { registerOpenApi } from "./plugins/openapi.js";
import { errorResponseSchema } from "./shared/error.schema.js";
import { createAppLogger } from "./shared/logger.js";

declare module "fastify" {
  interface FastifyInstance {
    config: Pick<AppConfig, "SSE_HEARTBEAT_MS" | "SSE_QUEUE_FRAMES" | "SSE_QUEUE_BYTES">;
    credentialEncryptionKey: string | undefined;
  }
}

// 健康探针等基础设施轮询频率高且几乎总是成功，跳过 incoming/completed 生命周期日志避免刷屏。
// 只影响 Fastify 内置请求日志；探针失败仍会经全局 setErrorHandler 的 request.log 记 error/warn。
const QUIET_REQUEST_PATHS = new Set(["/health/live", "/health/ready"]);

export function isQuietRequest(request: FastifyRequest): boolean {
  const queryIndex = request.url.indexOf("?");
  const pathname = queryIndex === -1 ? request.url : request.url.slice(0, queryIndex);
  return QUIET_REQUEST_PATHS.has(pathname);
}

export async function buildApp(config: AppConfig, options: { exportMode?: boolean } = {}) {
  const app = Fastify({
    loggerInstance: createAppLogger(config),
    logController: new LogController({ disableRequestLogging: isQuietRequest }),
    // 部署固定经 Nginx 单层反代, 且 Nginx 用 proxy_set_header 重写 x-forwarded-* (static-site conf.d),
    // 不存在客户端可注入的伪造链; 开启后 request.protocol 才能把 TLS 终结识别为 https,
    // /api/runner-connection 才会下发 wss:// 连接地址而非明文 ws://.
    trustProxy: true,
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
    // 本地目录视图与 skills 服务在此组装：Runner 接受回调、目录路由与会话入队共用同一实例。
    const localResources = new RunnerLocalResources((message, error) => app.log.warn({ err: error }, message));
    app.decorate("localResources", localResources);
    const uploadsEnabled = Boolean(config.MINIO_ENDPOINT && config.MINIO_ACCESS_KEY && config.MINIO_SECRET_KEY);
    const skillRepository = createSkillRepository(app.db);
    const skillService = new SkillService(
      skillRepository,
      localResources.port(),
      { storageConfigured: uploadsEnabled },
      createUserModelProfilesService(app),
    );
    localResources.setCatalogAcceptor((input) => skillService.accept(input));
    app.decorate("skillService", skillService);
    // 内置技能按 ID/版本/摘要登记为不可变版本（§6）；导出模式不启动连接也不登记。
    if (!options.exportMode) await skillService.registerBuiltins();
    await registerRunnerConnections(app, Boolean(options.exportMode), (info) =>
      localResources.attach(info.runnerRowId, info.ownerUserId, info.session),
    );
    const uploadStorage = uploadsEnabled
      ? createMinioUploadStorage(
          {
            endPoint: config.MINIO_ENDPOINT!,
            port: config.MINIO_PORT,
            useSSL: config.MINIO_USE_SSL,
            accessKey: config.MINIO_ACCESS_KEY!,
            secretKey: config.MINIO_SECRET_KEY!,
            bucket: config.MINIO_BUCKET,
          },
          (error, operation) =>
            app.log.error({ err: error, component: "attachment-storage", operation }, "MinIO operation failed"),
        )
      : disabledUploadStorage();
    // 产物存储与图片附件存储分离（红线：产物不套用图片专用接口），共用同一私有 bucket 前缀。
    const artifactStorage = uploadsEnabled
      ? createMinioArtifactStorage(
          {
            endPoint: config.MINIO_ENDPOINT!,
            port: config.MINIO_PORT,
            useSSL: config.MINIO_USE_SSL,
            accessKey: config.MINIO_ACCESS_KEY!,
            secretKey: config.MINIO_SECRET_KEY!,
            bucket: config.MINIO_BUCKET,
          },
          (error, operation) => app.log.error({ err: error, component: "artifact-storage", operation }, "MinIO artifact operation failed"),
        )
      : disabledArtifactStorage();
    const artifactService = createArtifactService(app.db, artifactStorage);
    if (!options.exportMode && (config.ROLE === "all" || config.ROLE === "worker"))
      startConversationExecution(
        app,
        config,
        createEventRetentionService(app.db, createConversationEventHeads(app.db)),
        uploadStorage,
        artifactService,
      );
    if (config.ROLE !== "worker") {
      await app.register(healthModule);
      await app.register(projectsModule, { prefix: "/api" });
      await app.register(async (scope) => conversationsModule(scope, artifactService, uploadStorage), { prefix: "/api" });
      await app.register(async (scope) =>
        skillsModule(scope, {
          service: skillService,
          repository: skillRepository,
          directory: localResources.port(),
          environment: {
            conversations: createConversationReader(app.db),
            bindings: createProjectBindingService(app),
            runnerReader: createRunnerReader(app.db),
            storageConfigured: uploadsEnabled,
          },
        }),
        { prefix: "/api" },
      );
      await app.register(async (scope) => artifactsModule(scope, artifactService), { prefix: "/api" });
      await app.register(specsModule, { prefix: "/api" });
      await app.register(async (scope) => attachmentsModule(scope, uploadStorage), { prefix: "/api" });
      await app.register(async (scope) => runnersModule(scope, localResources), { prefix: "/api" });
      await app.register(remotesModule, { prefix: "/api" });
      await app.register(eventsModule, { prefix: "/api", conversations: createConversationReader(app.db) });
      await app.register(runsModule, { prefix: "/api" });
      await app.register(async (scope) => clientConfigModule(scope, uploadsEnabled), { prefix: "/api" });
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
