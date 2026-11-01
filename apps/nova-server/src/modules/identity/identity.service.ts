import type { AppConfig } from "../../config.js";
import { DEV_LOCAL_USER_ID, DEV_MOCK_ACCESS_TOKEN, DEV_MOCK_USER } from "@nova/agent-ui-contracts/dev-auth";
import type { Database } from "../../../database/index.js";
import { DomainError } from "../../shared/domain-error.js";
import { createAuthServiceClient, type AuthServiceConfig, type VerifiedIdentity } from "./auth-service.js";
import { createIdentityRepository } from "./identity.repository.js";

/**
 * Identity service contract: 提供稳定 identity → local user 投影; 业务层不直接持有
 * Casdoor 配置或 access token。Casdoor 身份经 Auth Service 验证后原子投影到本地用户。
 *
 * See: docs/nova-server.md §10.1
 */
export type Principal = {
  /** 来自 Auth Service 的稳定身份标识(全局长 Entra/Casdoor sub); 唯一 */
  identityId: string;
  /** 本地 user.id, 首次登录按 identity_id 懒创建 */
  localUserId: string;
  /** 来自 Auth Service 的角色列表(经本地策略计算后); 仅 admin role 等少数场景写入 */
  roles: readonly string[];
};

export interface IdentityVerifier {
  /** 校验 Bearer access token 并返回 Principal, 无效/过期返回 UNAUTHORIZED */
  verifyAccessToken(token: string | undefined): Promise<Principal>;
  /** 当前禁用身份缓存，以及时检查上游撤销和本地 active 状态。 */
  tokenCacheTtlSeconds: number;
}

export class UnauthorizedDomainError extends DomainError {
  constructor(message = "Invalid or expired access token") {
    super("UNAUTHORIZED", message);
    this.name = "UnauthorizedDomainError";
  }
}

/**
 * 开发态 identity verifier: 仅在 AUTH_MODE=dev 时使用; 接受格式
 *   `dev:<userId>:<identityId>` 或共享的 model-console 开发 token。
 * loadConfig 拒绝 production + dev。
 */
export function createDevIdentityVerifier(): IdentityVerifier {
  return {
    tokenCacheTtlSeconds: 0,
    async verifyAccessToken(token) {
      if (!token) throw new UnauthorizedDomainError();
      // The model-console sends this fixed token only in Vite development mode.
      if (token === DEV_MOCK_ACCESS_TOKEN) {
        return {
          identityId: DEV_MOCK_USER.casdoorId,
          localUserId: DEV_LOCAL_USER_ID,
          roles: ["admin"],
        };
      }
      const match = /^dev:(?<user>[a-z0-9-]{1,64}):(?<identity>[a-z0-9-]{1,128})$/i.exec(token);
      if (!match?.groups) throw new UnauthorizedDomainError();
      const { user: localUserId, identity: identityId } = match.groups as {
        user: string;
        identity: string;
      };
      return {
        identityId,
        localUserId,
        roles: [],
      };
    },
  };
}

export function createCasdoorIdentityVerifier(
  auth: { verify(token: string): Promise<VerifiedIdentity> },
  users: { upsert(identity: VerifiedIdentity): Promise<{ id: string; active: boolean }> },
): IdentityVerifier {
  return {
    // Verify with the provider on every request so revocations are immediately visible.
    tokenCacheTtlSeconds: 0,
    async verifyAccessToken(token) {
      if (!token || token.length > 16384) throw new UnauthorizedDomainError();
      const identity = await auth.verify(token);
      const user = await users.upsert(identity);
      if (!user.active) throw new UnauthorizedDomainError("当前账号不可用");
      return { identityId: identity.identityId, localUserId: user.id, roles: identity.roles };
    },
  };
}

export function createIdentityVerifier(
  config: Pick<AppConfig, "AUTH_MODE"> & AuthServiceConfig,
  db?: Database,
): IdentityVerifier {
  if (config.AUTH_MODE === "dev") return createDevIdentityVerifier();
  if (!db) throw new Error("Casdoor identity verification requires a user repository");
  return createCasdoorIdentityVerifier(createAuthServiceClient(config), createIdentityRepository(db));
}
