import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import type { AppConfig } from "../../config.js";
import { createIdentityVerifier, type IdentityVerifier, type Principal } from "./identity.service.js";
import { DomainError } from "../../shared/domain-error.js";
import type { AuthServiceConfig } from "./auth-service.js";

declare module "fastify" {
  interface FastifyInstance {
    identity: IdentityVerifier;
  }
  interface FastifyRequest {
    /** 由 auth plugin 注入; 匿名路径下为 null */
    principal: Principal | null;
  }
}

/**
 * Identity plugin:
 * - 注册 IdentityVerifier 到 app.identity
 * - 解析 Authorization Bearer 并写入 req.auth
 * - 401 的统一处理委托给全局 error handler(DomainError path)
 *
 * 注意: 路由层 authz 由具体的 owner predicate 与 expectedRevision 等实现; 本
 * 插件不引入通用 authz 中间件,避免跨模块隐式权限策略。
 */
export const identityPlugin = fp(
  async (app: FastifyInstance, config: Pick<AppConfig, "AUTH_MODE"> & AuthServiceConfig) => {
    const verifier = createIdentityVerifier(config, app.db);
    app.decorate("identity", verifier);
    app.decorateRequest("principal", null as Principal | null);

    // preHandler 不强制 401, 让匿名路由可继续工作(如 /health/*)。
    // 真正的 401 由路由层显式调用 requirePrincipal() 触发。
    app.addHook("onRequest", async (request) => {
      const header = request.headers.authorization;
      if (!header || !header.toLowerCase().startsWith("bearer ")) return;
      const token = header.slice("bearer ".length).trim();
      try {
        request.principal = await verifier.verifyAccessToken(token);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "UNAUTHORIZED") throw error;
        // Invalid credentials are rejected by requirePrincipal; dependency failures remain 503.
        request.principal = null;
      }
    });
  },
  // Dev identity can be used without persistence; Casdoor construction requires app.db.
  { name: "identity" },
);

export type { Principal, IdentityVerifier } from "./identity.service.js";
