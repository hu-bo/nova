import {
  AuthServiceError,
  createAuthServiceClient as createSdkAuthServiceClient,
  type AuthServiceIdentity,
} from "@nova/casdoor/server/auth-service";
import { DomainError } from "../../shared/domain-error.js";
import type { AppConfig } from "../../config.js";

export type VerifiedIdentity = Omit<AuthServiceIdentity, "active">;
export type AuthServiceConfig = Pick<
  AppConfig,
  "AUTH_SERVICE_URL" | "AUTH_SERVICE_TOKEN_TRANSPORT" | "AUTH_SERVICE_TIMEOUT_MS"
>;

export function createAuthServiceClient(config: AuthServiceConfig, fetchImpl: typeof fetch = fetch) {
  const client = createSdkAuthServiceClient(
    {
      authApiBase: `${config.AUTH_SERVICE_URL.replace(/\/+$/, "")}/api`,
      tokenTransport: config.AUTH_SERVICE_TOKEN_TRANSPORT,
      timeoutMs: config.AUTH_SERVICE_TIMEOUT_MS,
    },
    fetchImpl,
  );
  return {
    async verify(token: string): Promise<VerifiedIdentity> {
      let identity: AuthServiceIdentity;
      try {
        identity = await client.verifyAccessToken(token);
      } catch (error) {
        if (!(error instanceof AuthServiceError)) throw error;
        throw new DomainError(
          error.code === "INVALID_TOKEN" ? "UNAUTHORIZED" : "SERVICE_UNAVAILABLE",
          error.code === "INVALID_TOKEN" ? "登录状态已过期，请重新登录" : "身份服务暂时不可用，请稍后重试",
        );
      }
      if (!identity.active) throw new DomainError("UNAUTHORIZED", "当前账号不可用");
      return { identityId: identity.identityId, displayName: identity.displayName, roles: identity.roles };
    },
  };
}
